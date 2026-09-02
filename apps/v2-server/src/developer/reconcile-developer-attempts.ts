import type {
  DeveloperAttempt,
  DomainEvent,
  ManagedWorkspace,
  WorkerExecution,
  WorkerExecutionId,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { V2EventStore } from '../storage/event-store.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { DeveloperRepository } from './developer-repository.js';

export type DeveloperAttemptReconciliation = {
  events: readonly DomainEvent[];
  pendingStartAttemptIds: readonly string[];
  pendingActivationIds: readonly WorkerExecutionId[];
  pendingInterruptAttemptIds: readonly string[];
};

type Dependencies = {
  database: V2Database;
  developers: Pick<
    DeveloperRepository,
    | 'attempt'
    | 'nonterminalAttempts'
    | 'startReservationForAttempt'
    | 'recordWorkspaceObservationInTransaction'
    | 'transitionAttemptInTransaction'
  >;
  executions: { get(id: WorkerExecutionId): WorkerExecution | undefined };
  workspace: {
    observe(workspace: ManagedWorkspace): Promise<ManagedWorkspace>;
  };
  planning: {
    planningSnapshotInTransaction(projectId: string): { board: unknown };
  };
  events: Pick<V2EventStore, 'appendDomainInTransaction'>;
  barrier: Pick<AuditBarrier, 'assertHealthy' | 'trip'>;
  now(): string;
};

const terminal = new Set<WorkerExecution['lifecycle']>([
  'completed',
  'failed',
  'interrupted',
]);

const sameWorkspaceObservation = (
  current: ManagedWorkspace,
  observed: ManagedWorkspace,
) =>
  canonicalJson({
    ...current,
    revision: 0,
    updatedAt: '',
  }) ===
  canonicalJson({
    ...observed,
    revision: 0,
    updatedAt: '',
  });

const desiredLifecycle = (
  attempt: DeveloperAttempt,
  workspace: ManagedWorkspace,
  execution: WorkerExecution | undefined,
): {
  lifecycle: DeveloperAttempt['lifecycle'];
  attention: DeveloperAttempt['attention'];
} => {
  if (workspace.lifecycle !== 'ready') {
    return {
      lifecycle: 'attention_required',
      attention: workspace.failure ?? {
        code: 'developer_workspace_conflict',
        message: 'Managed workspace ownership could not be proven',
      },
    };
  }
  if (!execution || execution.projectId !== attempt.projectId) {
    return {
      lifecycle: 'attention_required',
      attention: {
        code: 'developer_attempt_transition_conflict',
        message: 'Controlling execution could not be recovered',
      },
    };
  }
  if (
    attempt.lifecycle === 'interrupted' &&
    execution.lifecycle === 'running'
  ) {
    return { lifecycle: 'interrupted', attention: null };
  }
  if (execution.lifecycle === 'running' || execution.lifecycle === 'starting') {
    return { lifecycle: 'active', attention: null };
  }
  if (execution.lifecycle === 'attention_required') {
    return {
      lifecycle: 'attention_required',
      attention: {
        code: 'developer_attempt_transition_conflict',
        message: 'Controlling execution requires attention after recovery',
      },
    };
  }
  if (
    attempt.lifecycle === 'reserved' ||
    attempt.lifecycle === 'provisioning'
  ) {
    return {
      lifecycle: 'attention_required',
      attention: {
        code: 'developer_attempt_transition_conflict',
        message: 'Developer attempt was not fully activated before recovery',
      },
    };
  }
  if (attempt.reportIds.length === 0 && terminal.has(execution.lifecycle)) {
    return { lifecycle: 'interrupted', attention: null };
  }
  return { lifecycle: attempt.lifecycle, attention: attempt.attention };
};

export const reconcileDeveloperAttempts = async (
  dependencies: Dependencies,
): Promise<DeveloperAttemptReconciliation> => {
  dependencies.barrier.assertHealthy();
  const events: DomainEvent[] = [];
  const pendingStartAttemptIds: string[] = [];
  const pendingActivationIds: WorkerExecutionId[] = [];
  const pendingInterruptAttemptIds: string[] = [];

  for (const original of dependencies.developers.nonterminalAttempts()) {
    dependencies.barrier.assertHealthy();
    if (
      ['reserved', 'provisioning'].includes(original.lifecycle) &&
      dependencies.developers.startReservationForAttempt(original.id)
    ) {
      pendingStartAttemptIds.push(original.id);
      continue;
    }
    let observed: ManagedWorkspace;
    try {
      observed = await dependencies.workspace.observe(original.workspace);
      dependencies.barrier.assertHealthy();
    } catch (error) {
      dependencies.barrier.trip(error, dependencies.now());
      throw error;
    }
    try {
      inImmediateTransaction(dependencies.database, () => {
        const current = dependencies.developers.attempt(original.id);
        if (
          !current ||
          current.revision !== original.revision ||
          current.lifecycle !== original.lifecycle ||
          current.controllingExecutionId !== original.controllingExecutionId ||
          current.workspace.revision !== original.workspace.revision
        ) {
          return;
        }
        const execution = current.controllingExecutionId
          ? dependencies.executions.get(current.controllingExecutionId)
          : undefined;
        if (
          observed.lifecycle === 'ready' &&
          current.lifecycle === 'interrupted' &&
          current.controllingExecutionId === original.controllingExecutionId &&
          execution?.lifecycle === 'running'
        ) {
          pendingInterruptAttemptIds.push(current.id);
          return;
        }
        const desired = desiredLifecycle(current, observed, execution);
        const workspaceChanged = !sameWorkspaceObservation(
          current.workspace,
          observed,
        );
        if (
          !workspaceChanged &&
          desired.lifecycle === current.lifecycle &&
          canonicalJson(desired.attention) === canonicalJson(current.attention)
        ) {
          if (execution?.lifecycle === 'starting') {
            pendingActivationIds.push(execution.id);
          }
          return;
        }
        const board = dependencies.planning.planningSnapshotInTransaction(
          current.projectId,
        ).board;
        const workspace = workspaceChanged
          ? dependencies.developers.recordWorkspaceObservationInTransaction(
              {
                ...observed,
                revision: current.workspace.revision + 1,
                updatedAt: dependencies.now(),
              },
              current.workspace.revision,
            )
          : current.workspace;
        const changed = dependencies.developers.transitionAttemptInTransaction(
          {
            ...current,
            lifecycle: desired.lifecycle,
            revision: current.revision + 1,
            workspace,
            attention: desired.attention,
            updatedAt: dependencies.now(),
            endedAt: desired.lifecycle === 'active' ? null : dependencies.now(),
          },
          current.revision,
        );
        events.push(
          dependencies.events.appendDomainInTransaction(current.projectId, {
            projectId: current.projectId,
            occurredAt: changed.updatedAt,
            type: 'developer_attempt.changed',
            payload: {
              schemaVersion: 1,
              attempt: changed,
              board: board as never,
            },
          }),
        );
        if (
          execution?.lifecycle === 'starting' &&
          changed.lifecycle === 'active'
        ) {
          pendingActivationIds.push(execution.id);
        }
      });
    } catch (error) {
      dependencies.barrier.trip(error, dependencies.now());
      throw error;
    }
  }
  return {
    events,
    pendingStartAttemptIds,
    pendingActivationIds,
    pendingInterruptAttemptIds,
  };
};
