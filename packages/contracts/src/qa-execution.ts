import { z } from 'zod';

const id = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const actor = z.object({
  type: z.enum(['human', 'system', 'agent']),
  id,
  displayName: z.string().trim().min(1).optional(),
});

export const reviewPolicySchema = z.enum(['manual', 'autonomous_review']);

export const qaInstructionsSchema = z.object({
  content: z.string(),
  revision: z.number().int().positive(),
  updatedAt: timestamp,
  updatedBy: actor.nullable(),
});

export const qaConfigurationSchema = z.object({
  instructions: qaInstructionsSchema,
  reviewPolicy: reviewPolicySchema,
  revision: z.number().int().positive(),
  updatedAt: timestamp,
  updatedBy: actor.nullable(),
});

export const qaCriterionResultSchema = z.object({
  criterionId: id,
  status: z.enum(['passed', 'failed', 'skipped']),
  evidence: z.string().trim().min(1),
});

const qaReportBaseSchema = z.object({
  id,
  cycleId: id,
  disposition: z.enum(['verified', 'rejected']),
  criterionResults: z.array(qaCriterionResultSchema).min(1),
  verificationCommands: z.array(
    z.object({
      command: z.string().trim().min(1),
      outcome: z.string().trim().min(1),
    }),
  ),
  limitations: z.array(z.string().trim().min(1)),
  residualRisks: z.array(z.string().trim().min(1)),
  workspaceBefore: z.string().trim().min(1),
  workspaceAfter: z.string().trim().min(1),
  createdAt: timestamp,
});

type QaReportVerdict = Pick<
  z.infer<typeof qaReportBaseSchema>,
  'disposition' | 'criterionResults'
>;

const requirePassedCriteriaForVerified = (
  { disposition, criterionResults }: QaReportVerdict,
  context: z.RefinementCtx,
) => {
  if (disposition !== 'verified') return;

  for (const [index, result] of criterionResults.entries()) {
    if (result.status !== 'passed') {
      context.addIssue({
        code: 'custom',
        message:
          'Verified QA reports may contain only passed criterion results.',
        path: ['criterionResults', index, 'status'],
      });
    }
  }
};

export const qaReportSchema = qaReportBaseSchema.superRefine(
  requirePassedCriteriaForVerified,
);

export const qaReportInputSchema = qaReportBaseSchema
  .omit({
    id: true,
    cycleId: true,
    createdAt: true,
    verificationCommands: true,
    workspaceBefore: true,
    workspaceAfter: true,
  })
  .strict()
  .superRefine(requirePassedCriteriaForVerified);

const qaTaskSnapshotSchema = z
  .object({
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).default(''),
    description: z.string(),
    acceptanceCriteria: z.array(
      z.object({ id, text: z.string().trim().min(1) }),
    ),
  })
  .superRefine(({ acceptanceCriteria }, context) => {
    const criterionIds = new Set<string>();
    for (const [index, criterion] of acceptanceCriteria.entries()) {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: 'custom',
          message: 'QA task snapshot criterion IDs must be unique.',
          path: ['acceptanceCriteria', index, 'id'],
        });
      }
      criterionIds.add(criterion.id);
    }
  });

export const qaExecutionCycleSchema = z
  .object({
    id,
    taskId: id,
    attemptId: id,
    sessionId: id,
    ordinal: z.number().int().positive(),
    authorizedBy: actor,
    authorizationCommandId: id,
    policyVersion: z.string().trim().min(1),
    qaInstructions: qaInstructionsSchema.pick({
      content: true,
      revision: true,
    }),
    taskSnapshot: qaTaskSnapshotSchema,
    developerCompletionReportId: id,
    workspaceId: id,
    workspaceBaseline: z.string().trim().min(1).default('legacy-unavailable'),
    taskFingerprint: z.string().trim().min(1).default('legacy-unavailable'),
    reviewPolicy: reviewPolicySchema,
    reviewPolicyRevision: z.number().int().positive(),
    automationGeneration: z.number().int().nonnegative(),
    rejectionOrdinal: z.number().int().nonnegative(),
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
    terminalDisposition: z
      .enum(['verified', 'rejected', 'interrupted'])
      .nullable(),
    reportId: id.nullable(),
    terminalCommandId: id.nullable(),
    terminalEventId: id.nullable(),
  })
  .superRefine(
    (
      {
        endedAt,
        terminalDisposition,
        reportId,
        terminalCommandId,
        terminalEventId,
      },
      context,
    ) => {
      const terminalMetadata = [reportId, terminalCommandId, terminalEventId];

      if (terminalDisposition === null) {
        if (
          endedAt !== null ||
          terminalMetadata.some((value) => value !== null)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Active QA cycles may not carry terminal metadata.',
            path: ['terminalDisposition'],
          });
        }
        return;
      }

      if (endedAt === null) {
        context.addIssue({
          code: 'custom',
          message: 'Terminal QA cycle dispositions require an end time.',
          path: ['terminalDisposition'],
        });
      }
      if (terminalDisposition === 'interrupted') {
        if (reportId !== null) {
          context.addIssue({
            code: 'custom',
            message: 'Interrupted QA cycles may not invent a QA report.',
            path: ['reportId'],
          });
        }
        for (const [field, value] of [
          ['terminalCommandId', terminalCommandId],
          ['terminalEventId', terminalEventId],
        ] as const) {
          if (value === null) {
            context.addIssue({
              code: 'custom',
              message: 'Interrupted QA cycles require repair audit metadata.',
              path: [field],
            });
          }
        }
        return;
      }
      for (const [index, value] of terminalMetadata.entries()) {
        if (value === null) {
          context.addIssue({
            code: 'custom',
            message:
              'Terminal QA cycles require report, command, and event metadata.',
            path: [['reportId', 'terminalCommandId', 'terminalEventId'][index]],
          });
        }
      }
    },
  );

export const reviewAutomationStatusSchema = z.enum([
  'disabled',
  'enabled',
  'paused',
]);

export const reviewAutomationStateSchema = z.object({
  status: reviewAutomationStatusSchema,
  generation: z.number().int().nonnegative(),
  rejectionCount: z.number().int().nonnegative(),
  pauseReason: z.string().trim().min(1).nullable(),
  updatedAt: timestamp,
});

export const reviewAutomationActionSchema = z.object({
  id,
  idempotencyKey: id,
  projectId: id,
  taskId: id,
  attemptId: id,
  sourceCycleId: id,
  actionKind: z.enum([
    'launch_qa',
    'resume_developer',
    'complete_task',
    'pause_automation',
  ]),
  generation: z.number().int().nonnegative(),
  status: z.enum(['pending', 'completed', 'failed']),
  errorCode: z.string().trim().min(1).nullable(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
});

export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
export type QaInstructions = z.infer<typeof qaInstructionsSchema>;
export type QaConfiguration = z.infer<typeof qaConfigurationSchema>;
export type QaCriterionResult = z.infer<typeof qaCriterionResultSchema>;
export type QaReport = z.infer<typeof qaReportSchema>;
export type QaReportInput = z.infer<typeof qaReportInputSchema>;
export type QaExecutionCycle = z.infer<typeof qaExecutionCycleSchema>;
export type ReviewAutomationState = z.infer<typeof reviewAutomationStateSchema>;
export type ReviewAutomationAction = z.infer<
  typeof reviewAutomationActionSchema
>;
