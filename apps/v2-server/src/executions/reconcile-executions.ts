import type {
  HarnessAdapter,
  HarnessOperationResult,
  HarnessProbeResult,
  HarnessSession,
  WorkerExecution,
  WorkerExecutionLifecycle,
} from '@mesh/v2-contracts';

import type { V2EventStore } from '../storage/event-store.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import type {
  ExecutionOperation,
  OperationRepository,
} from './operation-repository.js';

export type ReconciliationSummary = {
  resumed: readonly string[];
  terminalized: readonly string[];
  attentionRequired: readonly string[];
};

type Dependencies = {
  executions: ExecutionRepository;
  operations: OperationRepository;
  adapter: HarnessAdapter;
  events: V2EventStore;
  barrier: AuditBarrier;
  attach(executionId: string, session: HarnessSession): void | Promise<void>;
};

const terminal = new Set<WorkerExecutionLifecycle>([
  'completed',
  'failed',
  'interrupted',
]);

const lifecycleDraft = (execution: WorkerExecution, occurredAt: string) => ({
  projectId: execution.projectId,
  occurredAt,
  type: 'worker_execution.lifecycle_changed' as const,
  payload: { execution },
});

const operationObservation = async (
  adapter: HarnessAdapter,
  execution: WorkerExecution,
  operation: ExecutionOperation,
  probe: HarnessProbeResult,
): Promise<{
  state: 'succeeded' | 'unknown';
  result: unknown;
  lifecycle?: WorkerExecutionLifecycle;
}> => {
  if (operation.kind === 'start') {
    if (probe.status === 'resumable')
      return { state: 'succeeded', result: { probe } };
    if (probe.status === 'terminal') {
      return {
        state: 'succeeded',
        result: { probe },
        lifecycle: probe.outcome,
      };
    }
    return { state: 'unknown', result: { probe } };
  }
  let interrupt: HarnessOperationResult;
  try {
    interrupt = execution.nativeHandle
      ? await adapter.interrupt(execution.nativeHandle)
      : { status: 'unknown', reason: 'Execution has no native handle' };
  } catch (error) {
    return {
      state: 'unknown',
      result: {
        probe,
        interruptError: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (interrupt.status === 'succeeded') {
    return {
      state: 'succeeded',
      result: { probe, interrupt },
      lifecycle: 'interrupted',
    };
  }
  if (
    interrupt.status === 'already_terminal' &&
    probe.status === 'terminal' &&
    probe.outcome === 'interrupted'
  ) {
    return {
      state: 'succeeded',
      result: { probe, interrupt },
      lifecycle: 'interrupted',
    };
  }
  return { state: 'unknown', result: { probe, interrupt } };
};

export const reconcileExecutions = async (
  dependencies: Dependencies,
): Promise<ReconciliationSummary> => {
  dependencies.barrier.assertHealthy();
  const open = dependencies.executions.listOpen();
  const pending = dependencies.operations.listPending();
  const byId = new Map(open.map((execution) => [execution.id, execution]));
  for (const operation of pending) {
    const execution = dependencies.executions.get(operation.executionId);
    if (execution) byId.set(execution.id, execution);
  }
  const summary = {
    resumed: [] as string[],
    terminalized: [] as string[],
    attentionRequired: [] as string[],
  };

  for (const execution of [...byId.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const executionPending = pending.filter(
      (operation) => operation.executionId === execution.id,
    );
    if (execution.lifecycle === 'created' && executionPending.length === 0) {
      const occurredAt = new Date().toISOString();
      try {
        dependencies.executions.transaction(() => {
          dependencies.events.appendRawDiagnosticInTransaction({
            projectId: execution.projectId,
            executionId: execution.id,
            adapterId: execution.adapterId,
            adapterCursor: null,
            receivedAt: occurredAt,
            payload: {
              kind: 'mesh.v2.reconciliation-probe/v1',
              reason: 'Execution was never reserved for adapter start',
            },
          });
          const failed = dependencies.executions.transitionInTransaction(
            execution.id,
            execution.revision,
            'failed',
            occurredAt,
            {
              failure: {
                code: 'startup_interrupted_before_start',
                message: 'Startup ended before adapter start was reserved',
              },
            },
          );
          dependencies.events.appendDomainInTransaction(
            execution.projectId,
            lifecycleDraft(failed, occurredAt),
          );
        });
      } catch (error) {
        dependencies.barrier.trip(error, occurredAt);
        throw error;
      }
      summary.terminalized.push(execution.id);
      continue;
    }
    let probe: HarnessProbeResult;
    try {
      probe = execution.nativeHandle
        ? await dependencies.adapter.probe(execution.nativeHandle)
        : { status: 'unknown', reason: 'Execution has no native handle' };
    } catch (error) {
      probe = {
        status: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const observations = [] as Array<{
      operation: ExecutionOperation;
      observation: Awaited<ReturnType<typeof operationObservation>>;
    }>;
    for (const operation of executionPending) {
      observations.push({
        operation,
        observation: await operationObservation(
          dependencies.adapter,
          execution,
          operation,
          probe,
        ),
      });
    }

    let desired: WorkerExecutionLifecycle | undefined;
    let recoveredSession: HarnessSession | undefined;
    let recoveryError: string | undefined;
    const interruptProof = observations.find(
      ({ operation, observation }) =>
        operation.kind === 'interrupt' &&
        observation.lifecycle === 'interrupted',
    );
    const hasPendingInterrupt = observations.some(
      ({ operation }) => operation.kind === 'interrupt',
    );
    if (!terminal.has(execution.lifecycle)) {
      if (execution.lifecycle === 'attention_required') {
        desired = 'attention_required';
      } else if (interruptProof) {
        desired =
          execution.lifecycle === 'interrupting'
            ? 'interrupted'
            : 'attention_required';
      } else if (hasPendingInterrupt) {
        desired = 'attention_required';
      } else if (probe.status === 'terminal') {
        if (
          probe.outcome === 'completed' &&
          execution.lifecycle === 'running'
        ) {
          desired = 'completed';
        } else if (
          probe.outcome === 'failed' &&
          ['starting', 'running', 'interrupting'].includes(execution.lifecycle)
        ) {
          desired = 'failed';
        } else if (
          probe.outcome === 'interrupted' &&
          execution.lifecycle === 'interrupting'
        ) {
          desired = 'interrupted';
        } else {
          desired = 'attention_required';
        }
      } else if (
        probe.status === 'resumable' &&
        execution.lifecycle === 'running' &&
        probe.afterAdapterCursor === execution.lastAdapterCursor &&
        observations.every(
          ({ observation }) => observation.state === 'succeeded',
        )
      ) {
        const project = dependencies.executions.getProject(execution.projectId);
        if (!project || !execution.nativeHandle) {
          desired = 'attention_required';
          recoveryError = !project
            ? 'Execution project was not found during recovery'
            : 'Execution native handle was not found during recovery';
        } else {
          try {
            recoveredSession = await dependencies.adapter.resume({
              executionId: execution.id,
              project,
              assignment: execution.assignment,
              profile: execution.profileSnapshot,
              resolvedSkills: execution.resolvedSkills,
              nativeHandle: execution.nativeHandle,
              afterAdapterCursor: execution.lastAdapterCursor,
            });
          } catch (error) {
            desired = 'attention_required';
            recoveryError =
              error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        desired = 'attention_required';
      }
    }

    const occurredAt = new Date().toISOString();
    try {
      dependencies.executions.transaction(() => {
        if (observations.length === 0) {
          dependencies.events.appendRawDiagnosticInTransaction({
            projectId: execution.projectId,
            executionId: execution.id,
            adapterId: execution.adapterId,
            adapterCursor: null,
            receivedAt: occurredAt,
            payload: {
              kind: 'mesh.v2.reconciliation-probe/v1',
              probe,
              ...(recoveryError === undefined ? {} : { recoveryError }),
            },
          });
        }
        for (const [
          operationOrder,
          { operation, observation },
        ] of observations.entries()) {
          dependencies.events.appendRawDiagnosticInTransaction({
            projectId: execution.projectId,
            executionId: execution.id,
            adapterId: execution.adapterId,
            adapterCursor: null,
            receivedAt: occurredAt,
            payload: {
              kind: 'mesh.v2.reconciliation-probe/v1',
              operationId: operation.id,
              operationOrder,
              probe,
              observation: observation.result,
              ...(recoveryError === undefined ? {} : { recoveryError }),
            },
          });
          dependencies.operations.finishInTransaction(
            operation.id,
            observation.state,
            observation.result,
            occurredAt,
          );
        }
        if (
          desired === undefined ||
          terminal.has(execution.lifecycle) ||
          desired === execution.lifecycle
        ) {
          return;
        }
        const current = dependencies.executions.get(execution.id);
        if (!current)
          throw new Error('Execution disappeared during reconciliation');
        const changed = dependencies.executions.transitionInTransaction(
          execution.id,
          current.revision,
          desired,
          occurredAt,
          desired === 'failed'
            ? {
                failure: {
                  code: 'internal_error',
                  message:
                    'Adapter reported execution failure during reconciliation',
                },
              }
            : {},
        );
        dependencies.events.appendDomainInTransaction(
          execution.projectId,
          lifecycleDraft(changed, occurredAt),
        );
      });
    } catch (error) {
      if (recoveredSession) await recoveredSession.close();
      dependencies.barrier.trip(error, occurredAt);
      throw error;
    }
    if (recoveredSession) {
      try {
        await dependencies.attach(execution.id, recoveredSession);
        summary.resumed.push(execution.id);
      } catch (error) {
        await recoveredSession.close();
        const attachmentFailedAt = new Date().toISOString();
        try {
          dependencies.executions.transaction(() => {
            dependencies.events.appendRawDiagnosticInTransaction({
              projectId: execution.projectId,
              executionId: execution.id,
              adapterId: execution.adapterId,
              adapterCursor: null,
              receivedAt: attachmentFailedAt,
              payload: {
                kind: 'mesh.v2.reconciliation-attach-failed/v1',
                reason: error instanceof Error ? error.message : String(error),
              },
            });
            const current = dependencies.executions.get(execution.id);
            if (!current) {
              throw new Error('Recovered execution disappeared before attach');
            }
            const attention = dependencies.executions.transitionInTransaction(
              current.id,
              current.revision,
              'attention_required',
              attachmentFailedAt,
            );
            dependencies.events.appendDomainInTransaction(
              current.projectId,
              lifecycleDraft(attention, attachmentFailedAt),
            );
          });
        } catch (auditError) {
          dependencies.barrier.trip(auditError, attachmentFailedAt);
          throw auditError;
        }
        summary.attentionRequired.push(execution.id);
      }
    }
    if (desired && terminal.has(desired))
      summary.terminalized.push(execution.id);
    if (
      desired === 'attention_required' ||
      (terminal.has(execution.lifecycle) && observations.length > 0)
    ) {
      summary.attentionRequired.push(execution.id);
    }
  }
  return summary;
};
