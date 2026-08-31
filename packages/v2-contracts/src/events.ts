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
import {
  approvedIntentLedgerSchema,
  approvedPlanningOutcomeSchema,
  legacyM2PlanningCycleViewSchema,
} from './intent';
import {
  approvedDeliveryPlanMaterializationSchema,
  approvedDeliveryPlanSchema,
  deliveryPlanPlanningCycleViewSchema,
  planningCycleViewSchema,
  taskRevisionSchema,
  type PlanningCycleView,
} from './delivery-plan';
import { boardViewSchema, type BoardView } from './board';
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
export const legacyM2PlanningCycleChangedPayloadSchema = z.strictObject({
  planningCycle: legacyM2PlanningCycleViewSchema,
});
export const m3PlanningCycleChangedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(2),
  planningCycle: planningCycleViewSchema,
});
export const persistedPlanningCycleChangedPayloadSchema = z.union([
  legacyM2PlanningCycleChangedPayloadSchema,
  m3PlanningCycleChangedPayloadSchema,
]);
export type PersistedPlanningCycleChangedPayload = z.infer<
  typeof persistedPlanningCycleChangedPayloadSchema
>;

export const legacyM2IntentLedgerApprovedPayloadSchema =
  approvedPlanningOutcomeSchema;
export const m3IntentLedgerApprovedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    planningCycle: planningCycleViewSchema,
    intentLedger: approvedIntentLedgerSchema,
    board: boardViewSchema,
  })
  .superRefine((value, context) => {
    if (value.planningCycle.purpose.kind !== 'intent') {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle', 'purpose'],
        message: 'Intent approval requires an intent planning cycle',
      });
      return;
    }
    const approved = approvedPlanningOutcomeSchema.safeParse({
      planningCycle: {
        cycle: value.planningCycle.cycle,
        turns: value.planningCycle.turns,
        questions: value.planningCycle.questions,
        proposals: value.planningCycle.proposals,
      },
      intentLedger: value.intentLedger,
    });
    if (!approved.success) {
      for (const issue of approved.error.issues) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
    }
    if (value.board.projectId !== value.planningCycle.cycle.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['board', 'projectId'],
        message: 'Intent approval Board must match the cycle project',
      });
    }
    if (
      value.board.deliveryPlanRevision === null
        ? value.board.emptyReason !== 'planning_required'
        : !value.board.stale
    ) {
      context.addIssue({
        code: 'custom',
        path: ['board'],
        message:
          'Intent approval must require planning or preserve a stale approved plan',
      });
    }
  });
export const persistedIntentLedgerApprovedPayloadSchema = z.union([
  legacyM2IntentLedgerApprovedPayloadSchema,
  m3IntentLedgerApprovedPayloadSchema,
]);
export type PersistedIntentLedgerApprovedPayload = z.infer<
  typeof persistedIntentLedgerApprovedPayloadSchema
>;

export const deliveryPlanApprovedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    planningCycle: deliveryPlanPlanningCycleViewSchema,
    deliveryPlan: approvedDeliveryPlanSchema,
    board: boardViewSchema,
  })
  .superRefine((value, context) => {
    const latest = value.planningCycle.deliveryPlanProposals.at(-1);
    const proposalBase = latest?.base;
    if (
      value.planningCycle.cycle.lifecycle !== 'approved' ||
      latest?.lifecycle !== 'approved' ||
      latest.id !== value.deliveryPlan.plan.proposalId ||
      value.deliveryPlan.plan.projectId !==
        value.planningCycle.cycle.projectId ||
      value.deliveryPlan.plan.projectIntentId !==
        proposalBase?.projectIntentId ||
      value.deliveryPlan.plan.projectIntentRevision !==
        proposalBase?.projectIntentRevision ||
      value.deliveryPlan.plan.ledgerId !== proposalBase?.ledgerId ||
      value.deliveryPlan.plan.ledgerRevision !== proposalBase?.ledgerRevision ||
      value.deliveryPlan.plan.baseDeliveryPlanRevision !==
        proposalBase?.deliveryPlan.revision ||
      (proposalBase?.deliveryPlan.id !== null &&
        value.deliveryPlan.plan.id !== proposalBase?.deliveryPlan.id) ||
      value.deliveryPlan.plan.summary !== latest.proposedPlan.summary ||
      value.board.projectId !== value.deliveryPlan.plan.projectId ||
      value.board.deliveryPlanRevision !== value.deliveryPlan.plan.revision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlan'],
        message: 'Plan approval event cycle, plan, and Board must agree',
      });
    }
    if (latest !== undefined) {
      const materialized = approvedDeliveryPlanMaterializationSchema.safeParse({
        proposal: latest,
        deliveryPlan: value.deliveryPlan,
      });
      if (!materialized.success) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlan'],
          message: 'Plan approval event must exactly materialize its proposal',
        });
      }
    }
  });
export const boardFilterChangedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  board: boardViewSchema,
});
export const taskLifecycleChangedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    task: taskRevisionSchema,
    board: boardViewSchema,
  })
  .refine((value) => value.task.revisionKind === 'operational_lifecycle', {
    path: ['task', 'revisionKind'],
    message: 'Lifecycle events require operational task revisions',
  });

const planningCycleChangedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('planning_cycle.changed'),
  payload: persistedPlanningCycleChangedPayloadSchema,
});
const intentLedgerApprovedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('intent_ledger.approved'),
  payload: persistedIntentLedgerApprovedPayloadSchema,
});
const deliveryPlanApprovedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('delivery_plan.approved'),
  payload: deliveryPlanApprovedPayloadSchema,
});
const boardFilterChangedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('board.filter_changed'),
  payload: boardFilterChangedPayloadSchema,
});
const taskLifecycleChangedDraftSchema = z.strictObject({
  ...domainEventBase,
  type: z.literal('task.lifecycle_changed'),
  payload: taskLifecycleChangedPayloadSchema,
});

const requireDomainEventProjectCoherence = (
  value:
    | z.infer<typeof projectRegisteredDraftSchema>
    | z.infer<typeof profileApprovedDraftSchema>
    | z.infer<typeof executionLifecycleDraftSchema>
    | z.infer<typeof planningCycleChangedDraftSchema>
    | z.infer<typeof intentLedgerApprovedDraftSchema>
    | z.infer<typeof deliveryPlanApprovedDraftSchema>
    | z.infer<typeof boardFilterChangedDraftSchema>
    | z.infer<typeof taskLifecycleChangedDraftSchema>,
  context: z.RefinementCtx,
) => {
  const embeddedProjectId =
    value.type === 'project.registered'
      ? value.payload.project.id
      : value.type === 'worker_profile.revision_approved'
        ? value.payload.profileRevision.projectId
        : value.type === 'worker_execution.lifecycle_changed'
          ? value.payload.execution.projectId
          : value.type === 'planning_cycle.changed' ||
              value.type === 'intent_ledger.approved' ||
              value.type === 'delivery_plan.approved'
            ? value.payload.planningCycle.cycle.projectId
            : value.type === 'board.filter_changed'
              ? value.payload.board.projectId
              : value.payload.task.projectId;
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
  if (
    (value.type === 'delivery_plan.approved' ||
      value.type === 'board.filter_changed' ||
      value.type === 'task.lifecycle_changed') &&
    value.payload.board.projectId !== value.projectId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'board'],
      message: 'Board must match the domain event project',
    });
  }
};

export const domainEventDraftSchema = z
  .union([
    projectRegisteredDraftSchema,
    profileApprovedDraftSchema,
    executionLifecycleDraftSchema,
    planningCycleChangedDraftSchema,
    intentLedgerApprovedDraftSchema,
    deliveryPlanApprovedDraftSchema,
    boardFilterChangedDraftSchema,
    taskLifecycleChangedDraftSchema,
  ])
  .superRefine(requireDomainEventProjectCoherence);
export type DomainEventDraft = z.infer<typeof domainEventDraftSchema>;

export const domainEventSchema = z
  .union([
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
    deliveryPlanApprovedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    boardFilterChangedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
    taskLifecycleChangedDraftSchema.extend({
      id: domainEventIdSchema,
      sequence: nonNegativeIntegerSchema,
    }),
  ])
  .superRefine(requireDomainEventProjectCoherence);
export type DomainEvent = z.infer<typeof domainEventSchema>;

const planningRequiredBoard = (projectId: string): BoardView =>
  boardViewSchema.parse({
    projectId,
    deliveryPlanRevision: null,
    stale: false,
    emptyReason: 'planning_required',
    filter: null,
    totalTaskCount: 0,
    matchedTaskCount: 0,
    facets: {
      milestones: [],
      taskLifecycles: [],
      readiness: [],
      priorities: [],
      labels: [],
      requirements: [],
    },
    cards: [],
  });

export const normalizePlanningCycleChangedPayload = (
  payload: PersistedPlanningCycleChangedPayload,
): { schemaVersion: 2; planningCycle: PlanningCycleView } =>
  'schemaVersion' in payload
    ? payload
    : {
        schemaVersion: 2,
        planningCycle: planningCycleViewSchema.parse({
          ...payload.planningCycle,
          purpose: {
            kind: 'intent',
            baseDeliveryPlanId: null,
            baseDeliveryPlanRevision: null,
          },
          deliveryPlanProposals: [],
        }),
      };

export const normalizeIntentLedgerApprovedPayload = (
  payload: PersistedIntentLedgerApprovedPayload,
) =>
  'schemaVersion' in payload
    ? payload
    : {
        schemaVersion: 2 as const,
        planningCycle: normalizePlanningCycleChangedPayload({
          planningCycle: payload.planningCycle,
        }).planningCycle,
        intentLedger: payload.intentLedger,
        deliveryPlan: null,
        board: planningRequiredBoard(payload.planningCycle.cycle.projectId),
      };

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
