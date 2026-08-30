import type { DomainEvent } from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { ExecutionRepository } from '../executions/execution-repository.js';
import type {
  ExecutionRuntime,
  ExecutionRuntimeObserver,
} from '../executions/execution-runtime.js';
import type { WorkerProfileService } from '../profiles/profile-service.js';
import type { V2CommandRepository } from '../storage/command-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import { PlanningRepository } from './planning-repository.js';
import {
  PlanningService,
  type PmExecutionLauncher,
} from './planning-service.js';
import { PmReportConsumer } from './pm-report-consumer.js';

type PlanningExecutionRuntime = Pick<
  ExecutionRuntime,
  | 'findReservedStart'
  | 'reserveStart'
  | 'activateReserved'
  | 'cancelReserved'
  | 'interruptForPlanning'
>;

export const createPlanningLauncher = (
  runtime: PlanningExecutionRuntime,
): PmExecutionLauncher => ({
  findReserved: (input) => runtime.findReservedStart(input),
  reserve: (input) => runtime.reserveStart(input),
  activate: (executionId) => runtime.activateReserved(executionId),
  cancelReserved: (executionId) => runtime.cancelReserved(executionId),
  interruptForPlanning: (executionId) =>
    runtime.interruptForPlanning(executionId),
});

export const createPlanningRuntime = (dependencies: {
  database: V2Database;
  commands: V2CommandRepository;
  events: V2EventStore;
  executions: ExecutionRepository;
  profiles: Pick<WorkerProfileService, 'resolveApproved'>;
  executionRuntime: PlanningExecutionRuntime;
  barrier: AuditBarrier;
  now: () => string;
  publishDomain(event: DomainEvent): void;
}) => {
  const repository = new PlanningRepository(dependencies.database);
  const reportConsumer = new PmReportConsumer({
    database: dependencies.database,
    repository,
    events: dependencies.events,
    barrier: dependencies.barrier,
    publishDomain: dependencies.publishDomain,
  });
  const service = new PlanningService({
    database: dependencies.database,
    repository,
    commands: dependencies.commands,
    events: dependencies.events,
    executions: dependencies.executions,
    profiles: dependencies.profiles,
    launcher: createPlanningLauncher(dependencies.executionRuntime),
    barrier: dependencies.barrier,
    reportConsumer,
    now: dependencies.now,
    publishDomain: dependencies.publishDomain,
  });
  const observer: ExecutionRuntimeObserver = {
    structuredOutput: (execution, event) =>
      reportConsumer.consume(execution, event),
    terminal: (execution) => service.reconcileTerminalExecution(execution.id),
  };
  return { repository, service, observer };
};
