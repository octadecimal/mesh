import { z } from 'zod';

const uuid = () => z.string().uuid();
const brandedUuid = <T extends string>() => uuid().brand<T>();

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

export const planningCycleIdSchema = brandedUuid<'PlanningCycleId'>();
export type PlanningCycleId = z.infer<typeof planningCycleIdSchema>;

export const planningTurnIdSchema = brandedUuid<'PlanningTurnId'>();
export type PlanningTurnId = z.infer<typeof planningTurnIdSchema>;

export const planningQuestionIdSchema = brandedUuid<'PlanningQuestionId'>();
export type PlanningQuestionId = z.infer<typeof planningQuestionIdSchema>;

export const planningProposalIdSchema = brandedUuid<'PlanningProposalId'>();
export type PlanningProposalId = z.infer<typeof planningProposalIdSchema>;

export const projectIntentIdSchema = brandedUuid<'ProjectIntentId'>();
export type ProjectIntentId = z.infer<typeof projectIntentIdSchema>;

export const ledgerIdSchema = brandedUuid<'LedgerId'>();
export type LedgerId = z.infer<typeof ledgerIdSchema>;

export const ledgerRecordIdSchema = brandedUuid<'LedgerRecordId'>();
export type LedgerRecordId = z.infer<typeof ledgerRecordIdSchema>;

export const deliveryPlanIdSchema = brandedUuid<'DeliveryPlanId'>();
export type DeliveryPlanId = z.infer<typeof deliveryPlanIdSchema>;

export const deliveryPlanProposalIdSchema =
  brandedUuid<'DeliveryPlanProposalId'>();
export type DeliveryPlanProposalId = z.infer<
  typeof deliveryPlanProposalIdSchema
>;

export const milestoneIdSchema = brandedUuid<'MilestoneId'>();
export type MilestoneId = z.infer<typeof milestoneIdSchema>;

export const taskIdSchema = brandedUuid<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;

export const taskDependencyIdSchema = brandedUuid<'TaskDependencyId'>();
export type TaskDependencyId = z.infer<typeof taskDependencyIdSchema>;

export const developerAttemptIdSchema = brandedUuid<'DeveloperAttemptId'>();
export type DeveloperAttemptId = z.infer<typeof developerAttemptIdSchema>;

export const developerReportIdSchema = brandedUuid<'DeveloperReportId'>();
export type DeveloperReportId = z.infer<typeof developerReportIdSchema>;

export const isoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export type NonNegativeInteger = z.infer<typeof nonNegativeIntegerSchema>;

export const positiveIntegerSchema = z.number().int().positive();
export type PositiveInteger = z.infer<typeof positiveIntegerSchema>;
