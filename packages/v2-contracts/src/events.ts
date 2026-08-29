import { z } from 'zod';

import {
  domainEventIdSchema,
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  projectIdSchema,
  rawDiagnosticIdSchema,
  runtimeEventIdSchema,
  workerExecutionIdSchema,
} from './ids';
import { workerExecutionSchema } from './executions';
import { approvedIntentLedgerSchema, planningCycleViewSchema } from './intent';
import { projectSchema } from './projects';
import { workerProfileRevisionSchema } from './profiles';

const domainEventBase = {
  projectId: projectIdSchema,
  occurredAt: isoTimestampSchema,
};

const projectRegisteredDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('project.registered'),
  payload: z.strictObject({ project: projectSchema }),
});
const profileApprovedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('worker_profile.revision_approved'),
  payload: z.strictObject({ profileRevision: workerProfileRevisionSchema }),
});
const executionLifecycleDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('worker_execution.lifecycle_changed'),
  payload: z.strictObject({ execution: workerExecutionSchema }),
});
const planningCycleChangedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('planning_cycle.changed'),
  payload: z.strictObject({ planningCycle: planningCycleViewSchema }),
});
const intentLedgerApprovedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('intent_ledger.approved'),
  payload: z.strictObject({
    planningCycle: planningCycleViewSchema,
    intentLedger: approvedIntentLedgerSchema,
  }),
});

const requireDomainEventProjectCoherence = (
  value:
    | z.infer<typeof projectRegisteredDraftSchema>
    | z.infer<typeof profileApprovedDraftSchema>
    | z.infer<typeof executionLifecycleDraftSchema>
    | z.infer<typeof planningCycleChangedDraftSchema>
    | z.infer<typeof intentLedgerApprovedDraftSchema>,
  context: z.RefinementCtx,
) => {
  const embeddedProjectId =
    value.type === 'project.registered'
      ? value.payload.project.id
      : value.type === 'worker_profile.revision_approved'
        ? value.payload.profileRevision.projectId
        : value.type === 'worker_execution.lifecycle_changed'
          ? value.payload.execution.projectId
          : value.payload.planningCycle.cycle.projectId;
  if (embeddedProjectId !== value.projectId) {
    context.addIssue({
      code: 'custom',
      path: ['payload'],
      message: 'Embedded record project must match the domain event project',
    });
  }
  if (
    value.type === 'intent_ledger.approved' &&
    value.payload.intentLedger.projectIntent.projectId !== value.projectId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'intentLedger'],
      message: 'Approved intent ledger must match the domain event project',
    });
  }
};

export const domainEventDraftSchema = z
  .discriminatedUnion('type', [
    projectRegisteredDraftSchema,
    profileApprovedDraftSchema,
    executionLifecycleDraftSchema,
    planningCycleChangedDraftSchema,
    intentLedgerApprovedDraftSchema,
  ])
  .superRefine(requireDomainEventProjectCoherence);
export type DomainEventDraft = z.infer<typeof domainEventDraftSchema>;

export const domainEventSchema = z
  .discriminatedUnion('type', [
    projectRegisteredDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    profileApprovedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    executionLifecycleDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    planningCycleChangedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    intentLedgerApprovedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
  ])
  .superRefine(requireDomainEventProjectCoherence);
export type DomainEvent = z.infer<typeof domainEventSchema>;

const runtimeEventBase = {
  projectId: projectIdSchema,
  executionId: workerExecutionIdSchema,
  adapterCursor: nonNegativeIntegerSchema,
  occurredAt: isoTimestampSchema,
};

const outputDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.output'),
  payload: z.strictObject({ text: z.string().max(64 * 1024) }),
});
const childStartedDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.child_started'),
  payload: z.strictObject({
    childId: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(256),
  }),
});
const childFinishedDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.child_finished'),
  payload: z.strictObject({
    childId: z.string().trim().min(1).max(256),
    outcome: z.enum(['completed', 'failed', 'interrupted']),
  }),
});
const adapterFailedDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.adapter_failed'),
  payload: z.strictObject({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(4096),
  }),
});
export const executionStructuredOutputDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.structured_output'),
  payload: z.strictObject({
    schema: z.string().trim().min(1).max(256),
    value: z.unknown(),
  }),
});
export type WorkerExecutionStructuredOutputRuntimeEventDraft = z.infer<
  typeof executionStructuredOutputDraftSchema
>;
export const executionCompletedDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.completed'),
  payload: z.strictObject({ outcome: z.literal('completed') }),
});
export type WorkerExecutionCompletedRuntimeEventDraft = z.infer<
  typeof executionCompletedDraftSchema
>;

export const runtimeEventDraftSchema = z.discriminatedUnion('type', [
  outputDraftSchema,
  childStartedDraftSchema,
  childFinishedDraftSchema,
  adapterFailedDraftSchema,
  executionStructuredOutputDraftSchema,
  executionCompletedDraftSchema,
]);
export type RuntimeEventDraft = z.infer<typeof runtimeEventDraftSchema>;

export const runtimeEventSchema = z.discriminatedUnion('type', [
  outputDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
  childStartedDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
  childFinishedDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
  adapterFailedDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
  executionStructuredOutputDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
  executionCompletedDraftSchema.extend({
    id: runtimeEventIdSchema,
    diagnosticId: rawDiagnosticIdSchema,
    sequence: nonNegativeIntegerSchema,
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type WorkerExecutionCompletedRuntimeEvent = Extract<
  RuntimeEvent,
  { type: 'worker_execution.completed' }
>;
export type WorkerExecutionStructuredOutputRuntimeEvent = Extract<
  RuntimeEvent,
  { type: 'worker_execution.structured_output' }
>;

export const rawDiagnosticDraftSchema = z.strictObject({
  projectId: projectIdSchema,
  executionId: workerExecutionIdSchema.nullable(),
  adapterId: z.string().trim().min(1).max(128),
  adapterCursor: nonNegativeIntegerSchema.nullable(),
  receivedAt: isoTimestampSchema,
  payload: z.unknown(),
});
export type RawDiagnosticDraft = z.infer<typeof rawDiagnosticDraftSchema>;

export const rawDiagnosticSchema = rawDiagnosticDraftSchema.extend({
  id: rawDiagnosticIdSchema,
});
export type RawDiagnostic = z.infer<typeof rawDiagnosticSchema>;

export const harnessEventEnvelopeSchema = z
  .strictObject({
    adapterCursor: nonNegativeIntegerSchema,
    raw: z.unknown(),
    normalized: runtimeEventDraftSchema,
  })
  .superRefine((value, context) => {
    if (value.adapterCursor !== value.normalized.adapterCursor) {
      context.addIssue({
        code: 'custom',
        path: ['normalized', 'adapterCursor'],
        message:
          'Normalized event cursor must match the harness envelope cursor',
      });
    }
  });
export type HarnessEventEnvelope = z.infer<typeof harnessEventEnvelopeSchema>;

export const retainedDomainWindowSchema = z.strictObject({
  lowWater: nonNegativeIntegerSchema,
  highWater: nonNegativeIntegerSchema,
  events: z.array(domainEventSchema).readonly(),
});
export type RetainedDomainWindow = z.infer<typeof retainedDomainWindowSchema>;

export const retainedRuntimeWindowSchema = z.strictObject({
  lowWater: nonNegativeIntegerSchema,
  highWater: nonNegativeIntegerSchema,
  events: z.array(runtimeEventSchema).readonly(),
});
export type RetainedRuntimeWindow = z.infer<typeof retainedRuntimeWindowSchema>;

export const projectEventCursorsSchema = z.strictObject({
  domain: nonNegativeIntegerSchema,
  runtime: nonNegativeIntegerSchema,
});
export type ProjectEventCursors = z.infer<typeof projectEventCursorsSchema>;
