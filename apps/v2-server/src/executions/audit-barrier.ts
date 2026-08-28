export type AuditBarrierStatus = 'healthy' | 'tripped';

export type UnhealthyDiagnostic = {
  occurredAt: string;
  message: string;
  cause?: string;
};

export type AuditBarrierHealth = Readonly<{
  status: AuditBarrierStatus;
  diagnostics: readonly Readonly<UnhealthyDiagnostic>[];
}>;

export class AuditBarrier {
  private currentStatus: AuditBarrierStatus = 'healthy';
  private readonly unhealthyDiagnostics: UnhealthyDiagnostic[] = [];

  get status(): AuditBarrierStatus {
    return this.currentStatus;
  }

  get diagnostics(): readonly Readonly<UnhealthyDiagnostic>[] {
    return this.list();
  }

  list(): readonly Readonly<UnhealthyDiagnostic>[] {
    return Object.freeze(
      this.unhealthyDiagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic }),
      ),
    );
  }

  health(): AuditBarrierHealth {
    return Object.freeze({
      status: this.currentStatus,
      diagnostics: this.list(),
    });
  }

  assertHealthy(): void {
    if (this.currentStatus === 'tripped') {
      throw new Error('Audit barrier is tripped');
    }
  }

  trip(error: unknown, occurredAt = new Date().toISOString()): void {
    this.currentStatus = 'tripped';
    this.record('Durable audit persistence failed', error, occurredAt);
  }

  record(
    message: string,
    error?: unknown,
    occurredAt = new Date().toISOString(),
  ): void {
    this.unhealthyDiagnostics.push({
      occurredAt,
      message,
      ...(error === undefined
        ? {}
        : { cause: error instanceof Error ? error.message : String(error) }),
    });
  }
}
