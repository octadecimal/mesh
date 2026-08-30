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
  planningCycleViewSchema,
} from './intent';
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
    cursors: projectEventCursorsSchema,
  })
  .superRefine((value, context) => {
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
      .filter(({ cycle }) => cycle.lifecycle === 'approved')
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
  });
export type V2ProjectSnapshot = z.infer<typeof v2ProjectSnapshotSchema>;

const commandFailureSchema = z.strictObject({
  ok: z.literal(false),
  commandType: v2CommandTypeSchema,
  error: z.strictObject({
    code: v2ErrorCodeSchema,
    message: z.string().trim().min(1).max(4096),
  }),
});

const planningProposalApproveResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_proposal.approve'),
    planningCycle: planningCycleViewSchema,
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

const planningTurnSubmitResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_cycle.submit_turn'),
    planningCycle: planningCycleViewSchema,
  })
  .refine((value) => value.planningCycle.cycle.lifecycle === 'launch_pending', {
    path: ['planningCycle', 'cycle', 'lifecycle'],
    message: 'Submit-turn success must be launch-pending',
  });

const planningProposalRejectResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_proposal.reject'),
    planningCycle: planningCycleViewSchema,
  })
  .refine(
    (value) => value.planningCycle.cycle.lifecycle === 'proposal_rejected',
    {
      path: ['planningCycle', 'cycle', 'lifecycle'],
      message: 'Reject success must be proposal-rejected',
    },
  );

const planningCycleAbandonResultSchema = z
  .strictObject({
    ok: z.literal(true),
    commandType: z.literal('planning_cycle.abandon'),
    planningCycle: planningCycleViewSchema,
  })
  .refine((value) => value.planningCycle.cycle.lifecycle === 'abandoned', {
    path: ['planningCycle', 'cycle', 'lifecycle'],
    message: 'Abandon success must be abandoned',
  });

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
  planningTurnSubmitResultSchema,
  planningProposalApproveResultSchema,
  planningProposalRejectResultSchema,
  planningCycleAbandonResultSchema,
  commandFailureSchema,
]);
export type V2CommandResult = z.infer<typeof v2CommandResultSchema>;
