import {
  developerReportSchema,
  developerTaskAssignmentSchema,
  type DeveloperReport,
  type WorkerExecution,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';

type Dependencies = {
  attempts: {
    acceptReport(
      execution: WorkerExecution,
      event: WorkerExecutionStructuredOutputRuntimeEvent,
      report: DeveloperReport | null,
    ): void;
    terminal(execution: WorkerExecution): void;
  };
};

export class DeveloperReportConsumer {
  constructor(private readonly dependencies: Dependencies) {}

  structuredOutput(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
  ): void {
    if (!developerTaskAssignmentSchema.safeParse(execution.assignment).success)
      return;
    const parsed = developerReportSchema.safeParse(event.payload.value);
    this.dependencies.attempts.acceptReport(
      execution,
      event,
      parsed.success ? parsed.data : null,
    );
  }

  terminal(execution: WorkerExecution): void {
    if (!developerTaskAssignmentSchema.safeParse(execution.assignment).success)
      return;
    this.dependencies.attempts.terminal(execution);
  }
}
