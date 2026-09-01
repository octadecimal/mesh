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
  pendingActivationIds: readonly WorkerExecutionId[];
};

type Dependencies = {
  database: V2Database;
  developers: Pick<
    DeveloperRepository,
    | 'attempt'
    | 'nonterminalAttempts'
    | 'recordWorkspaceObservationInTransaction'
    | 'transitionAttemptInTransaction'
  >;
  executions: { get(id: WorkerExecutionId): WorkerExecution | undefined };
  workspace: {
    observe(workspace: ManagedWorkspace): Promise<ManagedWorkspace>;
  };
  planning: {
    taskExecutionAuthority(
      projectId: string,
      taskId: string,
    ): { board: unknown } | undefined;
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
  const pendingActivationIds: WorkerExecutionId[] = [];

  for (const original of dependencies.developers.nonterminalAttempts()) {
    dependencies.barrier.assertHealthy();
    let observed: ManagedWorkspace;
    try {
      observed = await dependencies.workspace.observe(original.workspace);
      dependencies.barrier.assertHealthy();
    } catch (error) {
      dependencies.barrier.trip(error, dependencies.now());
      throw error;
    }
    const execution = original.controllingExecutionId
      ? dependencies.executions.get(original.controllingExecutionId)
      : undefined;
    const desired = desiredLifecycle(original, observed, execution);
    const workspaceChanged = !sameWorkspaceObservation(
      original.workspace,
      observed,
    );
    if (
      !workspaceChanged &&
      desired.lifecycle === original.lifecycle &&
      canonicalJson(desired.attention) === canonicalJson(original.attention)
    ) {
      if (execution?.lifecycle === 'starting')
        pendingActivationIds.push(execution.id);
      continue;
    }

    try {
      inImmediateTransaction(dependencies.database, () => {
        const current = dependencies.developers.attempt(original.id);
        if (!current)
          throw new Error('Developer attempt disappeared during recovery');
        const authority = dependencies.planning.taskExecutionAuthority(
          current.projectId,
          current.taskId,
        );
        if (!authority)
          throw new Error(
            'Task execution authority was not found during recovery',
          );
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
              board: authority.board as never,
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
  return { events, pendingActivationIds };
};
