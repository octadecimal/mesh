import { z } from 'zod';

import {
  attemptRepairSchema,
  blockedConditionSchema,
  idSchema,
  isoTimestampSchema,
  projectSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
} from './domain.js';
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
} from './developer-execution.js';
import {
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  reviewAutomationStateSchema,
} from './qa-execution.js';
import { projectRunSchema } from './project-runs.js';
import { protocolVersionSchema } from './protocol.js';

const projectEvent = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) =>
  z.object({
    protocolVersion: protocolVersionSchema,
    id: idSchema,
    projectId: idSchema,
    sequence: z.number().int().positive(),
    occurredAt: isoTimestampSchema,
    type: z.literal(type),
    payload,
  });

export const projectChangedEventSchema = projectEvent(
  'project.changed',
  z.object({ project: projectSchema }),
);
export const taskChangedEventSchema = projectEvent(
  'task.changed',
  z.object({ task: taskSchema }),
);
export const taskTransitionedEventSchema = projectEvent(
  'task.transitioned',
  z.object({ task: taskSchema, transition: taskTransitionSchema }),
);
export const taskBlockChangedEventSchema = projectEvent(
  'task.block_changed',
  z.object({ task: taskSchema, blocked: blockedConditionSchema.nullable() }),
);
export const taskRankChangedEventSchema = projectEvent(
  'task.rank_changed',
  z.object({ task: taskSchema }),
);
export const taskAttemptChangedEventSchema = projectEvent(
  'task.attempt_changed',
  z.object({ attempt: taskAttemptSchema }),
);
export const taskAttemptRepairDetectedEventSchema = projectEvent(
  'task.attempt_repair_detected',
  z.object({ repair: attemptRepairSchema }),
);
export const projectDeveloperInstructionsChangedEventSchema = projectEvent(
  'project.developer_instructions_changed',
  z.object({ project: projectSchema }),
);
export const projectQaConfigurationChangedEventSchema = projectEvent(
  'project.qa_configuration_changed',
  z.object({ project: projectSchema }),
);
export const projectRunChangedEventSchema = projectEvent(
  'project.run_changed',
  z.object({ run: projectRunSchema }),
);
const taskQaExecutionChangedPayloadSchema = z
  .object({
    task: taskSchema,
    attempt: taskAttemptSchema,
    cycle: qaExecutionCycleSchema,
    report: qaReportSchema.nullable(),
  })
  .superRefine(({ cycle, report }, context) => {
    if (report === null) return;

    if (report.cycleId !== cycle.id) {
      context.addIssue({
        code: 'custom',
        message: 'QA reports must belong to their QA cycle.',
        path: ['report', 'cycleId'],
      });
    }
    const expectedCriterionIds = new Set(
      cycle.taskSnapshot.acceptanceCriteria.map(({ id }) => id),
    );
    const reportedCriterionIds = new Set<string>();
    for (const [index, result] of report.criterionResults.entries()) {
      if (!expectedCriterionIds.has(result.criterionId)) {
        context.addIssue({
          code: 'custom',
          message: 'QA reports may only reference snapshotted criteria.',
          path: ['report', 'criterionResults', index, 'criterionId'],
        });
      }
      if (reportedCriterionIds.has(result.criterionId)) {
        context.addIssue({
          code: 'custom',
          message: 'QA reports must include each criterion only once.',
          path: ['report', 'criterionResults', index, 'criterionId'],
        });
      }
      reportedCriterionIds.add(result.criterionId);
    }
    for (const criterionId of expectedCriterionIds) {
      if (!reportedCriterionIds.has(criterionId)) {
        context.addIssue({
          code: 'custom',
          message: 'QA reports must cover every snapshotted criterion.',
          path: ['report', 'criterionResults'],
        });
      }
    }
  });
export const taskQaExecutionChangedEventSchema = projectEvent(
  'task.qa_execution_changed',
  taskQaExecutionChangedPayloadSchema,
);
export const taskReviewAutomationChangedEventSchema = projectEvent(
  'task.review_automation_changed',
  z.object({
    task: taskSchema,
    automation: reviewAutomationStateSchema,
    action: reviewAutomationActionSchema.nullable(),
  }),
);
const taskDeveloperExecutionChangedPayloadSchema = z
  .object({
    task: taskSchema,
    attempt: taskAttemptSchema,
    cycle: developerExecutionCycleSchema,
    completionReport: developerCompletionReportSchema.nullable(),
    blockerReport: developerBlockerReportSchema.nullable(),
    reviewFeedback: developerReviewFeedbackSchema.nullable(),
  })
  .superRefine(({ cycle, completionReport }, context) => {
    if (completionReport === null) {
      return;
    }

    const expectedCriterionIds = new Set(
      cycle.taskSnapshot.acceptanceCriteria.map(({ id }) => id),
    );
    const reportedCriterionIds = new Set<string>();

    for (const [index, result] of completionReport.criterionResults.entries()) {
      if (!expectedCriterionIds.has(result.criterionId)) {
        context.addIssue({
          code: 'custom',
          message:
            'Completion reports may only reference snapshotted criteria.',
          path: ['completionReport', 'criterionResults', index, 'criterionId'],
        });
      }
      if (reportedCriterionIds.has(result.criterionId)) {
        context.addIssue({
          code: 'custom',
          message: 'Completion reports must include each criterion only once.',
          path: ['completionReport', 'criterionResults', index, 'criterionId'],
        });
      }
      reportedCriterionIds.add(result.criterionId);
    }

    for (const criterionId of expectedCriterionIds) {
      if (!reportedCriterionIds.has(criterionId)) {
        context.addIssue({
          code: 'custom',
          message: 'Completion reports must cover every snapshotted criterion.',
          path: ['completionReport', 'criterionResults'],
        });
      }
    }
  });

export const taskDeveloperExecutionChangedEventSchema = projectEvent(
  'task.developer_execution_changed',
  taskDeveloperExecutionChangedPayloadSchema,
);

export const projectEventSchema = z.discriminatedUnion('type', [
  projectChangedEventSchema,
  taskChangedEventSchema,
  taskTransitionedEventSchema,
  taskBlockChangedEventSchema,
  taskRankChangedEventSchema,
  taskAttemptChangedEventSchema,
  taskAttemptRepairDetectedEventSchema,
  projectDeveloperInstructionsChangedEventSchema,
  projectQaConfigurationChangedEventSchema,
  projectRunChangedEventSchema,
  taskDeveloperExecutionChangedEventSchema,
  taskQaExecutionChangedEventSchema,
  taskReviewAutomationChangedEventSchema,
]);

export type ProjectEvent = z.infer<typeof projectEventSchema>;
export type ProjectEventDraft = Omit<ProjectEvent, 'id' | 'sequence'>;
