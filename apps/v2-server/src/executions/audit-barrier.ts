export type AuditBarrierStatus = 'healthy' | 'tripped';

export type UnhealthyDiagnostic = {
  occurredAt: string;
  message: string;
  cause?: string;
};

export class AuditBarrier {
  status: AuditBarrierStatus = 'healthy';
  readonly diagnostics: UnhealthyDiagnostic[] = [];

  assertHealthy(): void {
    if (this.status === 'tripped') throw new Error('Audit barrier is tripped');
  }

  trip(error: unknown, occurredAt = new Date().toISOString()): void {
    this.status = 'tripped';
    this.record('Durable audit persistence failed', error, occurredAt);
  }

  record(
    message: string,
    error?: unknown,
    occurredAt = new Date().toISOString(),
  ): void {
    this.diagnostics.push({
      occurredAt,
      message,
      ...(error === undefined
        ? {}
        : { cause: error instanceof Error ? error.message : String(error) }),
    });
  }
}
