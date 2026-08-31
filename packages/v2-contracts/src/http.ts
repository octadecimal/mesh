import { z } from 'zod';

import { v2CommandTypeSchema } from './commands';
import { v2ErrorCodeSchema, workerExecutionSchema } from './executions';
import { projectEventCursorsSchema } from './events';
import {
  projectIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import {
  approvedIntentLedgerSchema,
  approvedPlanningOutcomeSchema,
  legacyM2PlanningCycleViewSchema,
} from './intent';
import { boardViewSchema, type BoardView } from './board';
import {
  approvedDeliveryPlanSchema,
  deliveryPlanPlanningCycleViewSchema,
  intentPlanningCycleViewSchema,
  planningCycleViewSchema,
  type IntentPlanningCycleView,
  type PlanningCycleView,
} from './delivery-plan';
import { projectSchema } from './projects';
import {
  profileNameSchema,
  resolvedWorkerProfileSnapshotSchema,
  workerProfileRevisionSchema,
} from './profiles';

export const V2_PROTOCOL_VERSION = 'mesh.v2/1' as const;

export const v2ProtocolVersionSchema = z.literal(V2_PROTOCOL_VERSION);
export type V2ProtocolVersion = z.infer<typeof v2ProtocolVersionSchema>;

export const v2HealthSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({
    status: z.literal('audit_barrier_tripped'),
    error: z.strictObject({
      code: z.literal('audit_barrier_tripped'),
      message: z.string().trim().min(1).max(4096),
    }),
  }),
]);
export type V2Health = z.infer<typeof v2HealthSchema>;

export const workerProfileSummarySchema = z
  .strictObject({
    profileId: workerProfileIdSchema,
    projectId: projectIdSchema.nullable(),
    scope: z.enum(['global', 'project']),
    name: profileNameSchema,
    displayName: z.string().trim().min(1).max(256),
    approvedRevision: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Project ID must match profile summary scope',
      });
    }
  });
export type WorkerProfileSummary = z.infer<typeof workerProfileSummarySchema>;

export const v2SystemSnapshotSchema = z
  .strictObject({
    protocolVersion: v2ProtocolVersionSchema,
    health: v2HealthSchema,
    projects: z.array(projectSchema).readonly(),
    globalProfiles: z.array(workerProfileSummarySchema).readonly(),
  })
  .superRefine((value, context) => {
    value.globalProfiles.forEach((profile, index) => {
      if (profile.scope !== 'global') {
        context.addIssue({
          code: 'custom',
          path: ['globalProfiles', index, 'scope'],
          message: 'System snapshot global profiles must have global scope',
        });
      }
    });
  });
export type V2SystemSnapshot = z.infer<typeof v2SystemSnapshotSchema>;

export const v2AttentionItemSchema = z.strictObject({
  executionId: workerExecutionIdSchema,
  code: v2ErrorCodeSchema,
  message: z.string().trim().min(1).max(4096),
});
export type V2AttentionItem = z.infer<typeof v2AttentionItemSchema>;

export const v2ProjectSnapshotSchema = z
  .strictObject({
    protocolVersion: v2ProtocolVersionSchema,
    project: projectSchema,
    profiles: z.array(resolvedWorkerProfileSnapshotSchema).readonly(),
    executions: z.array(workerExecutionSchema).readonly(),
    attentionItems: z.array(v2AttentionItemSchema).readonly(),
    planningCycles: z.array(planningCycleViewSchema).max(20).readonly(),
    planningHistoryTruncated: z.boolean(),
    intentLedger: approvedIntentLedgerSchema.nullable(),
    deliveryPlan: approvedDeliveryPlanSchema.nullable(),
    board: boardViewSchema,
    cursors: projectEventCursorsSchema,
  })
  .superRefine((value, context) => {
    const planningCycleIds = new Set<string>();
    const planningTurnIds = new Set<string>();
    value.profiles.forEach((profile, index) => {
      if (
        profile.projectId !== null &&
        profile.projectId !== value.project.id
      ) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'projectId'],
          message: 'Project profile must match the snapshot project',
        });
      }
    });
    value.executions.forEach((execution, index) => {
      if (execution.projectId !== value.project.id) {
        context.addIssue({
          code: 'custom',
          path: ['executions', index, 'projectId'],
          message: 'Execution must match the snapshot project',
        });
      }
    });
    value.planningCycles.forEach((planningCycle, index) => {
      if (planningCycleIds.has(planningCycle.cycle.id)) {
        context.addIssue({
          code: 'custom',
          path: ['planningCycles', index, 'cycle', 'id'],
          message: 'Planning cycle IDs must be unique',
        });
      }
      planningCycleIds.add(planningCycle.cycle.id);
      if (planningCycle.cycle.projectId !== value.project.id) {
        context.addIssue({
          code: 'custom',
          path: ['planningCycles', index, 'cycle', 'projectId'],
          message: 'Planning cycle must match the snapshot project',
        });
      }
      planningCycle.turns.forEach((turn, turnIndex) => {
        if (planningTurnIds.has(turn.id)) {
          context.addIssue({
            code: 'custom',
            path: ['planningCycles', index, 'turns', turnIndex, 'id'],
            message: 'Planning turn IDs must be unique across cycles',
          });
        }
        planningTurnIds.add(turn.id);
      });
    });
    const nonterminalCycles = value.planningCycles.filter(
      ({ cycle }) =>
        cycle.lifecycle !== 'approved' &&
        cycle.lifecycle !== 'proposal_rejected' &&
        cycle.lifecycle !== 'abandoned',
    );
    if (nonterminalCycles.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['planningCycles'],
        message:
          'A snapshot can contain at most one nonterminal planning cycle',
      });
    }
    const newestApprovedCycle = value.planningCycles
      .filter(
        ({ cycle, purpose }) =>
          cycle.lifecycle === 'approved' && purpose.kind === 'intent',
      )
      .reduce<(typeof value.planningCycles)[number] | null>(
        (newest, candidate) => {
          if (newest === null) return candidate;
          const candidateIntentRevision =
            (candidate.cycle.baseProjectIntentRevision ?? 0) + 1;
          const newestIntentRevision =
            (newest.cycle.baseProjectIntentRevision ?? 0) + 1;
          if (candidateIntentRevision !== newestIntentRevision) {
            return candidateIntentRevision > newestIntentRevision
              ? candidate
              : newest;
          }
          const candidateLedgerRevision =
            (candidate.cycle.baseLedgerRevision ?? 0) + 1;
          const newestLedgerRevision =
            (newest.cycle.baseLedgerRevision ?? 0) + 1;
          return candidateLedgerRevision > newestLedgerRevision
            ? candidate
            : newest;
        },
        null,
      );
    if (newestApprovedCycle !== null && value.intentLedger === null) {
      context.addIssue({
        code: 'custom',
        path: ['intentLedger'],
        message: 'Approved snapshot history requires an intent ledger',
      });
    }
    if (
      newestApprovedCycle === null &&
      !value.planningHistoryTruncated &&
      value.intentLedger !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['intentLedger'],
        message:
          'Untruncated snapshot without approval cannot have an intent ledger',
      });
    }
    if (newestApprovedCycle !== null && value.intentLedger !== null) {
      const latestProposal = newestApprovedCycle.proposals.at(-1);
      if (
        latestProposal === undefined ||
        value.intentLedger.projectIntent.proposalId !== latestProposal.id ||
        value.intentLedger.ledger.proposalId !== latestProposal.id ||
        value.intentLedger.projectIntent.revision !==
          (newestApprovedCycle.cycle.baseProjectIntentRevision ?? 0) + 1 ||
        value.intentLedger.ledger.revision !==
          (newestApprovedCycle.cycle.baseLedgerRevision ?? 0) + 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['intentLedger'],
          message:
            'Snapshot intent ledger must match the newest approved cycle',
        });
      }
    }
    if (
      value.intentLedger !== null &&
      value.intentLedger.projectIntent.projectId !== value.project.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['intentLedger', 'projectIntent', 'projectId'],
        message: 'Intent ledger must match the snapshot project',
      });
    }
    const newestApprovedPlanCycle = value.planningCycles
      .filter(
        ({ cycle, purpose }) =>
          cycle.lifecycle === 'approved' && purpose.kind === 'delivery_plan',
      )
      .reduce<(typeof value.planningCycles)[number] | null>(
        (newest, candidate) => {
          if (newest === null) return candidate;
          const candidateRevision =
            (candidate.purpose.baseDeliveryPlanRevision ?? 0) + 1;
          const newestRevision =
            (newest.purpose.baseDeliveryPlanRevision ?? 0) + 1;
          return candidateRevision > newestRevision ? candidate : newest;
        },
        null,
      );
    if (newestApprovedPlanCycle !== null && value.deliveryPlan === null) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlan'],
        message: 'Approved plan history requires a canonical delivery plan',
      });
    }
    if (
      newestApprovedPlanCycle === null &&
      !value.planningHistoryTruncated &&
      value.deliveryPlan !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlan'],
        message:
          'Untruncated snapshot without plan approval cannot have a delivery plan',
      });
    }
    if (newestApprovedPlanCycle !== null && value.deliveryPlan !== null) {
      const latestProposal =
        newestApprovedPlanCycle.deliveryPlanProposals.at(-1);
      const expectedRevision =
        (newestApprovedPlanCycle.purpose.baseDeliveryPlanRevision ?? 0) + 1;
      const basePlanId = newestApprovedPlanCycle.purpose.baseDeliveryPlanId;
      if (
        latestProposal === undefined ||
        value.deliveryPlan.plan.proposalId !== latestProposal.id ||
        value.deliveryPlan.plan.revision !== expectedRevision ||
        value.deliveryPlan.plan.baseDeliveryPlanRevision !==
          newestApprovedPlanCycle.purpose.baseDeliveryPlanRevision ||
        (basePlanId !== null && value.deliveryPlan.plan.id !== basePlanId) ||
        value.deliveryPlan.plan.projectIntentId !==
          latestProposal.base.projectIntentId ||
        value.deliveryPlan.plan.projectIntentRevision !==
          latestProposal.base.projectIntentRevision ||
        value.deliveryPlan.plan.ledgerId !== latestProposal.base.ledgerId ||
        value.deliveryPlan.plan.ledgerRevision !==
          latestProposal.base.ledgerRevision
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlan'],
          message:
            'Snapshot delivery plan must match the newest approved plan cycle',
        });
      }
    }
    if (value.deliveryPlan !== null) {
      if (
        value.intentLedger === null ||
        value.deliveryPlan.plan.projectId !== value.project.id ||
        value.board.projectId !== value.project.id ||
        value.board.deliveryPlanRevision !== value.deliveryPlan.plan.revision
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlan'],
          message:
            'Delivery plan and Board must match the snapshot project and revision',
        });
      }
      if (value.intentLedger !== null) {
        const stale =
          value.deliveryPlan.plan.projectIntentId !==
            value.intentLedger.projectIntent.id ||
          value.deliveryPlan.plan.projectIntentRevision !==
            value.intentLedger.projectIntent.revision ||
          value.deliveryPlan.plan.ledgerId !== value.intentLedger.ledger.id ||
          value.deliveryPlan.plan.ledgerRevision !==
            value.intentLedger.ledger.revision;
        if (value.board.stale !== stale) {
          context.addIssue({
            code: 'custom',
            path: ['board', 'stale'],
            message:
              'Board staleness must reflect the current intent and ledger base',
          });
        }
      }
    } else if (
      value.board.projectId !== value.project.id ||
      value.board.deliveryPlanRevision !== null ||
      value.board.stale ||
      value.board.emptyReason !==
        (value.intentLedger === null ? 'intent_required' : 'planning_required')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['board'],
        message:
          'Pre-plan Board must match the snapshot and have no plan revision',
      });
    }
  });
export type V2ProjectSnapshot = z.infer<typeof v2ProjectSnapshotSchema>;

export const commandFailureSchema = z.strictObject({
  ok: z.literal(false),
  commandType: v2CommandTypeSchema,
  error: z.strictObject({
    code: v2ErrorCodeSchema,
    message: z.string().trim().min(1).max(4096),
  }),
});

export const legacyM2PlanningProposalApproveResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_proposal.approve'),
    planningCycle: legacyM2PlanningCycleViewSchema,
    intentLedger: approvedIntentLedgerSchema,
  })
  .superRefine((value, context) => {
    const result = approvedPlanningOutcomeSchema.safeParse({
      planningCycle: value.planningCycle,
      intentLedger: value.intentLedger,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
  });

export const legacyM2PlanningTurnSubmitResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_cycle.submit_turn'),
    planningCycle: legacyM2PlanningCycleViewSchema,
  })
  .refine((value) => value.planningCycle.cycle.lifecycle === 'launch_pending', {
    path: ['planningCycle', 'cycle', 'lifecycle'],
    message: 'Submit-turn success must be launch-pending',
  });

export const legacyM2PlanningProposalRejectResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_proposal.reject'),
    planningCycle: legacyM2PlanningCycleViewSchema,
  })
  .refine(
    (value) => value.planningCycle.cycle.lifecycle === 'proposal_rejected',
    {
      path: ['planningCycle', 'cycle', 'lifecycle'],
      message: 'Reject success must be proposal-rejected',
    },
  );

export const legacyM2PlanningCycleAbandonResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_cycle.abandon'),
    planningCycle: legacyM2PlanningCycleViewSchema,
  })
  .refine((value) => value.planningCycle.cycle.lifecycle === 'abandoned', {
    path: ['planningCycle', 'cycle', 'lifecycle'],
    message: 'Abandon success must be abandoned',
  });

export const legacyM2PlanningCommandSuccessSchema = z.union([
  legacyM2PlanningTurnSubmitResultSchema,
  legacyM2PlanningProposalApproveResultSchema,
  legacyM2PlanningProposalRejectResultSchema,
  legacyM2PlanningCycleAbandonResultSchema,
]);
export type LegacyM2PlanningCommandSuccess = z.infer<
  typeof legacyM2PlanningCommandSuccessSchema
>;

const requireIntentApprovalCoherence = (
  value: {
    planningCycle: PlanningCycleView;
    intentLedger: z.infer<typeof approvedIntentLedgerSchema>;
    board: BoardView;
  },
  context: z.RefinementCtx,
) => {
  if (value.planningCycle.purpose.kind !== 'intent') {
    context.addIssue({
      code: 'custom',
      path: ['planningCycle', 'purpose'],
      message: 'Intent approval requires an intent planning cycle',
    });
    return;
  }
  const parsed = approvedPlanningOutcomeSchema.safeParse({
    planningCycle: {
      cycle: value.planningCycle.cycle,
      turns: value.planningCycle.turns,
      questions: value.planningCycle.questions,
      proposals: value.planningCycle.proposals,
    },
    intentLedger: value.intentLedger,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
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
      message: 'Approval Board must match the planning project',
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
};

const versionedIntentSubmitResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('planning_cycle.submit_turn'),
    planningCycle: intentPlanningCycleViewSchema,
  })
  .superRefine((value, context) => {
    if (value.planningCycle.cycle.lifecycle !== 'launch_pending') {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle'],
        message: 'Intent submit success must be intent and launch-pending',
      });
    }
  });

const versionedIntentApproveResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('planning_proposal.approve'),
    planningCycle: intentPlanningCycleViewSchema,
    intentLedger: approvedIntentLedgerSchema,
    board: boardViewSchema,
  })
  .superRefine(requireIntentApprovalCoherence);

const versionedIntentRejectResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('planning_proposal.reject'),
    planningCycle: intentPlanningCycleViewSchema,
  })
  .superRefine((value, context) => {
    if (
      value.planningCycle.cycle.lifecycle !== 'proposal_rejected' ||
      value.planningCycle.proposals.at(-1)?.lifecycle !== 'rejected'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle'],
        message: 'Intent reject success requires a rejected intent proposal',
      });
    }
  });

const versionedPlanningAbandonResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('planning_cycle.abandon'),
    planningCycle: planningCycleViewSchema,
  })
  .refine((value) => value.planningCycle.cycle.lifecycle === 'abandoned', {
    path: ['planningCycle', 'cycle', 'lifecycle'],
    message: 'Abandon success must be abandoned',
  });

const versionedPlanSubmitResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('planning_cycle.submit_plan_turn'),
    planningCycle: deliveryPlanPlanningCycleViewSchema,
  })
  .superRefine((value, context) => {
    if (value.planningCycle.cycle.lifecycle !== 'launch_pending') {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle'],
        message: 'Plan submit success must be delivery-plan and launch-pending',
      });
    }
  });

const versionedPlanApproveResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('plan_proposal.approve'),
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
        message:
          'Plan approval cycle, proposal, canonical plan, and Board must agree',
      });
    }
  });

const versionedPlanRejectResultSchema = z
  .strictObject({
    ok: z.literal(true),
    schemaVersion: z.literal(2),
    commandType: z.literal('plan_proposal.reject'),
    planningCycle: deliveryPlanPlanningCycleViewSchema,
  })
  .superRefine((value, context) => {
    const latest = value.planningCycle.deliveryPlanProposals.at(-1);
    if (
      value.planningCycle.cycle.lifecycle !== 'proposal_rejected' ||
      latest?.lifecycle !== 'rejected'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle'],
        message: 'Plan reject success requires a rejected plan proposal',
      });
    }
  });

const versionedBoardFilterResultSchema = z.strictObject({
  ok: z.literal(true),
  schemaVersion: z.literal(2),
  commandType: z.literal('board_filter.set'),
  board: boardViewSchema,
});

export const versionedPlanningCommandSuccessSchema = z.union([
  versionedIntentSubmitResultSchema,
  versionedIntentApproveResultSchema,
  versionedIntentRejectResultSchema,
  versionedPlanningAbandonResultSchema,
  versionedPlanSubmitResultSchema,
  versionedPlanApproveResultSchema,
  versionedPlanRejectResultSchema,
  versionedBoardFilterResultSchema,
]);
export type VersionedPlanningCommandSuccess = z.infer<
  typeof versionedPlanningCommandSuccessSchema
>;

export const persistedPlanningCommandSuccessSchema = z.union([
  legacyM2PlanningCommandSuccessSchema,
  versionedPlanningCommandSuccessSchema,
]);
export type PersistedPlanningCommandSuccess = z.infer<
  typeof persistedPlanningCommandSuccessSchema
>;

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

const normalizeLegacyCycle = (
  planningCycle: LegacyM2PlanningCommandSuccess['planningCycle'],
): IntentPlanningCycleView =>
  planningCycleViewSchema.parse({
    ...planningCycle,
    purpose: {
      kind: 'intent',
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
    },
    deliveryPlanProposals: [],
  }) as IntentPlanningCycleView;

export type NormalizedPlanningCommandSuccess =
  | Readonly<{
      source: 'legacy_m2';
      projectionAuthority: 'receipt_only';
      result: VersionedPlanningCommandSuccess;
    }>
  | Readonly<{
      source: 'versioned';
      projectionAuthority: 'command_response';
      result: VersionedPlanningCommandSuccess;
    }>;

export const normalizePlanningCommandSuccess = (
  raw: PersistedPlanningCommandSuccess,
): NormalizedPlanningCommandSuccess => {
  if ('schemaVersion' in raw) {
    return {
      source: 'versioned',
      projectionAuthority: 'command_response',
      result: raw,
    };
  }
  const planningCycle = normalizeLegacyCycle(raw.planningCycle);
  const result: VersionedPlanningCommandSuccess =
    raw.commandType === 'planning_proposal.approve'
      ? versionedIntentApproveResultSchema.parse({
          ...raw,
          schemaVersion: 2,
          planningCycle,
          board: planningRequiredBoard(planningCycle.cycle.projectId),
        })
      : versionedPlanningCommandSuccessSchema.parse({
          ...raw,
          schemaVersion: 2,
          planningCycle,
        });
  return {
    source: 'legacy_m2',
    projectionAuthority: 'receipt_only',
    result,
  };
};

export const planningCommandResponseDispositionSchema = z.union([
  z.strictObject({
    kind: z.literal('apply_versioned'),
    result: versionedPlanningCommandSuccessSchema,
  }),
  z.strictObject({
    kind: z.literal('acknowledge_legacy'),
    reason: z.literal('legacy_m2_receipt'),
  }),
  z.strictObject({
    kind: z.literal('resync_required'),
    reason: z.literal('legacy_m2_freshness_unknown'),
  }),
]);
export type PlanningCommandResponseDisposition = z.infer<
  typeof planningCommandResponseDispositionSchema
>;

export const v2CommandResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('project.register'),
    project: projectSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_profile.approve_revision'),
    profileRevision: workerProfileRevisionSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_execution.start'),
    execution: workerExecutionSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_execution.interrupt'),
    execution: workerExecutionSchema,
  }),
  persistedPlanningCommandSuccessSchema,
  commandFailureSchema,
]);
export type V2CommandResult = z.infer<typeof v2CommandResultSchema>;
