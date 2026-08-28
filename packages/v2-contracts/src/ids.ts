import { z } from 'zod';

const uuid = () => z.string().uuid();

export const projectIdSchema = uuid();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const workerProfileIdSchema = uuid();
export type WorkerProfileId = z.infer<typeof workerProfileIdSchema>;

export const workerExecutionIdSchema = uuid();
export type WorkerExecutionId = z.infer<typeof workerExecutionIdSchema>;

export const domainEventIdSchema = uuid();
export type DomainEventId = z.infer<typeof domainEventIdSchema>;

export const runtimeEventIdSchema = uuid();
export type RuntimeEventId = z.infer<typeof runtimeEventIdSchema>;

export const rawDiagnosticIdSchema = uuid();
export type RawDiagnosticId = z.infer<typeof rawDiagnosticIdSchema>;

export const isoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export type NonNegativeInteger = z.infer<typeof nonNegativeIntegerSchema>;
