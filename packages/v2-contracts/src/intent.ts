import { z } from 'zod';

import {
  isoTimestampSchema,
  ledgerIdSchema,
  ledgerRecordIdSchema,
  nonNegativeIntegerSchema,
  planningCycleIdSchema,
  planningProposalIdSchema,
  planningQuestionIdSchema,
  planningTurnIdSchema,
  positiveIntegerSchema,
  projectIdSchema,
  projectIntentIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';

export const PM_DISCOVERY_REPORT_SCHEMA =
  'mesh.dev/pm-discovery-report/v1' as const;

export const boundedNarrativeSchema = z.string().trim().min(1).max(4096);
const boundedMessageSchema = z.string().trim().min(1).max(16_384);
const boundedKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const provenanceInputSchema = z.strictObject({
  kind: z.literal('conversation_turn'),
  turnId: planningTurnIdSchema,
  rationale: boundedNarrativeSchema,
});
export type ProvenanceInput = z.infer<typeof provenanceInputSchema>;

const provenanceListSchema = z
  .array(provenanceInputSchema)
  .min(1)
  .max(20)
  .readonly();
const narrativeListSchema = z
  .array(boundedNarrativeSchema)
  .min(1)
  .max(100)
  .readonly();

export const projectIntentContentSchema = z.strictObject({
  goal: boundedNarrativeSchema,
  targetUsers: narrativeListSchema,
  desiredCapabilities: narrativeListSchema,
  constraints: z.array(boundedNarrativeSchema).max(100).readonly(),
  nonGoals: z.array(boundedNarrativeSchema).max(100).readonly(),
  successConditions: narrativeListSchema,
  rationale: boundedNarrativeSchema,
  provenance: provenanceListSchema,
});
export type ProjectIntentContent = z.infer<typeof projectIntentContentSchema>;

export const requirementKindSchema = z.enum([
  'functional',
  'quality',
  'ux',
  'safety',
  'operational',
  'constraint',
]);
export type RequirementKind = z.infer<typeof requirementKindSchema>;

export const requirementStatusSchema = z.enum([
  'proposed',
  'approved',
  'superseded',
  'rejected',
  'retired',
]);
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

const recordContentBase = {
  statement: boundedNarrativeSchema,
  rationale: boundedNarrativeSchema,
};

export const requirementRecordContentSchema = z.strictObject({
  type: z.literal('requirement'),
  ...recordContentBase,
  kind: requirementKindSchema,
  status: requirementStatusSchema,
  priority: z.enum(['must', 'should', 'could']),
});
export type RequirementRecordContent = z.infer<
  typeof requirementRecordContentSchema
>;

export const decisionStatusSchema = z.enum(['active', 'superseded', 'retired']);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
export const decisionRecordContentSchema = z.strictObject({
  type: z.literal('decision'),
  ...recordContentBase,
  status: decisionStatusSchema,
});
export type DecisionRecordContent = z.infer<typeof decisionRecordContentSchema>;

export const assumptionStatusSchema = z.enum([
  'active',
  'confirmed',
  'invalidated',
  'retired',
]);
export type AssumptionStatus = z.infer<typeof assumptionStatusSchema>;
export const assumptionRecordContentSchema = z.strictObject({
  type: z.literal('assumption'),
  ...recordContentBase,
  status: assumptionStatusSchema,
  confidence: z.enum(['low', 'medium', 'high']),
});
export type AssumptionRecordContent = z.infer<
  typeof assumptionRecordContentSchema
>;

export const questionStatusSchema = z.enum(['open', 'answered', 'retired']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;
export const questionRecordContentSchema = z
  .strictObject({
    type: z.literal('question'),
    ...recordContentBase,
    status: questionStatusSchema,
    resolution: boundedNarrativeSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.status === 'answered') !== (value.resolution !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'Resolution is required exactly for answered questions',
      });
    }
  });
export type QuestionRecordContent = z.infer<typeof questionRecordContentSchema>;

export const riskStatusSchema = z.enum([
  'open',
  'mitigated',
  'accepted',
  'retired',
]);
export type RiskStatus = z.infer<typeof riskStatusSchema>;
export const riskRecordContentSchema = z.strictObject({
  type: z.literal('risk'),
  ...recordContentBase,
  status: riskStatusSchema,
  severity: z.enum(['low', 'medium', 'high']),
  mitigation: boundedNarrativeSchema,
});
export type RiskRecordContent = z.infer<typeof riskRecordContentSchema>;

export const ledgerRecordContentSchema = z.discriminatedUnion('type', [
  requirementRecordContentSchema,
  decisionRecordContentSchema,
  assumptionRecordContentSchema,
  questionRecordContentSchema,
  riskRecordContentSchema,
]);
export type LedgerRecordContent = z.infer<typeof ledgerRecordContentSchema>;

export const requirementRelationshipKindSchema = z.enum([
  'refines',
  'depends_on',
  'conflicts_with',
  'supersedes',
  'duplicates',
]);
export type RequirementRelationshipKind = z.infer<
  typeof requirementRelationshipKindSchema
>;

const ledgerRelationshipInputSchema = z.strictObject({
  kind: z.union([requirementRelationshipKindSchema, z.literal('constrains')]),
  fromRecordId: ledgerRecordIdSchema,
  toRecordId: ledgerRecordIdSchema,
});

export const ledgerRelationshipSchema = ledgerRelationshipInputSchema
  .superRefine((value, context) => {
    if (value.fromRecordId === value.toRecordId) {
      context.addIssue({
        code: 'custom',
        path: ['toRecordId'],
        message: 'Ledger relationships cannot be self-edges',
      });
    }
  })
  .transform((value) => {
    if (
      (value.kind === 'conflicts_with' || value.kind === 'duplicates') &&
      value.fromRecordId > value.toRecordId
    ) {
      return {
        ...value,
        fromRecordId: value.toRecordId,
        toRecordId: value.fromRecordId,
      };
    }
    return value;
  });
export type LedgerRelationship = z.infer<typeof ledgerRelationshipSchema>;

export const proposedLedgerEndpointSchema = z.union([
  z.strictObject({ recordId: ledgerRecordIdSchema }),
  z.strictObject({ proposalKey: boundedKeySchema }),
]);
export type ProposedLedgerEndpoint = z.infer<
  typeof proposedLedgerEndpointSchema
>;

const proposedRecordContentSchema = ledgerRecordContentSchema.refine(
  (content) => content.type !== 'requirement' || content.status !== 'approved',
  { message: 'Proposals cannot directly create approved requirements' },
);

export const proposedLedgerMemberSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('reuse'),
    recordId: ledgerRecordIdSchema,
    expectedRevision: positiveIntegerSchema,
  }),
  z.strictObject({
    operation: z.literal('revise'),
    recordId: ledgerRecordIdSchema,
    expectedRevision: positiveIntegerSchema,
    content: proposedRecordContentSchema,
    provenance: provenanceListSchema,
  }),
  z.strictObject({
    operation: z.literal('create'),
    key: boundedKeySchema,
    content: proposedRecordContentSchema,
    provenance: provenanceListSchema,
  }),
]);
export type ProposedLedgerMember = z.infer<typeof proposedLedgerMemberSchema>;

export const proposedLedgerRelationshipSchema = z.strictObject({
  kind: z.union([requirementRelationshipKindSchema, z.literal('constrains')]),
  from: proposedLedgerEndpointSchema,
  to: proposedLedgerEndpointSchema,
});
export type ProposedLedgerRelationship = z.infer<
  typeof proposedLedgerRelationshipSchema
>;

const endpointKey = (endpoint: ProposedLedgerEndpoint) =>
  'recordId' in endpoint
    ? `record:${endpoint.recordId}`
    : `proposal:${endpoint.proposalKey}`;

export const pmQuestionResultSchema = z
  .strictObject({
    kind: z.literal('questions'),
    questions: z
      .array(
        z.strictObject({
          key: boundedKeySchema,
          prompt: boundedNarrativeSchema,
          rationale: boundedNarrativeSchema,
          choices: z
            .array(boundedNarrativeSchema)
            .min(1)
            .max(20)
            .readonly()
            .optional(),
        }),
      )
      .min(1)
      .max(20)
      .readonly(),
  })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    value.questions.forEach((question, index) => {
      if (keys.has(question.key)) {
        context.addIssue({
          code: 'custom',
          path: ['questions', index, 'key'],
          message: 'Question keys must be unique',
        });
      }
      keys.add(question.key);
    });
  });
export type PmQuestionResult = z.infer<typeof pmQuestionResultSchema>;

export const pmProposalResultSchema = z
  .strictObject({
    kind: z.literal('proposal'),
    summary: boundedNarrativeSchema,
    projectIntent: projectIntentContentSchema,
    records: z.array(proposedLedgerMemberSchema).max(100).readonly(),
    relationships: z
      .array(proposedLedgerRelationshipSchema)
      .max(200)
      .readonly(),
  })
  .superRefine((value, context) => {
    const proposalKeys = new Set<string>();
    const recordIds = new Set<string>();
    value.records.forEach((member, index) => {
      if (member.operation === 'create') {
        if (proposalKeys.has(member.key)) {
          context.addIssue({
            code: 'custom',
            path: ['records', index, 'key'],
            message: 'Proposal keys must be unique',
          });
        }
        proposalKeys.add(member.key);
      } else {
        if (recordIds.has(member.recordId)) {
          context.addIssue({
            code: 'custom',
            path: ['records', index, 'recordId'],
            message: 'Record IDs must be unique in a proposal',
          });
        }
        recordIds.add(member.recordId);
      }
    });

    const edges = new Set<string>();
    value.relationships.forEach((relationship, index) => {
      const from = endpointKey(relationship.from);
      const to = endpointKey(relationship.to);
      if (from === to) {
        context.addIssue({
          code: 'custom',
          path: ['relationships', index, 'to'],
          message: 'Proposal relationships cannot be self-edges',
        });
      }
      for (const [side, endpoint] of [
        ['from', relationship.from],
        ['to', relationship.to],
      ] as const) {
        const resolves =
          'proposalKey' in endpoint
            ? proposalKeys.has(endpoint.proposalKey)
            : recordIds.has(endpoint.recordId);
        if (!resolves) {
          context.addIssue({
            code: 'custom',
            path: ['relationships', index, side],
            message: 'Relationship endpoint must resolve inside the proposal',
          });
        }
      }
      const symmetric =
        relationship.kind === 'conflicts_with' ||
        relationship.kind === 'duplicates';
      const [first, second] = symmetric && from > to ? [to, from] : [from, to];
      const edge = `${relationship.kind}:${first}:${second}`;
      if (edges.has(edge)) {
        context.addIssue({
          code: 'custom',
          path: ['relationships', index],
          message: 'Proposal relationships must be unique',
        });
      }
      edges.add(edge);
    });
  });
export type PmProposalResult = z.infer<typeof pmProposalResultSchema>;

export const planningCycleLifecycleSchema = z.enum([
  'discovering',
  'launch_pending',
  'execution_active',
  'awaiting_human',
  'awaiting_approval',
  'attention_required',
  'approved',
  'proposal_rejected',
  'abandoned',
]);
export type PlanningCycleLifecycle = z.infer<
  typeof planningCycleLifecycleSchema
>;

export const planningProposalLifecycleSchema = z.enum([
  'awaiting_approval',
  'superseded',
  'approved',
  'rejected',
]);
export type PlanningProposalLifecycle = z.infer<
  typeof planningProposalLifecycleSchema
>;

export const planningTurnLaunchStateSchema = z.enum([
  'launch_pending',
  'execution_bound',
]);
export type PlanningTurnLaunchState = z.infer<
  typeof planningTurnLaunchStateSchema
>;

const terminalPlanningCycleLifecycles = new Set<PlanningCycleLifecycle>([
  'approved',
  'proposal_rejected',
  'abandoned',
]);

export const planningCycleSchema = z
  .strictObject({
    id: planningCycleIdSchema,
    projectId: projectIdSchema,
    lifecycle: planningCycleLifecycleSchema,
    revision: nonNegativeIntegerSchema,
    profileId: workerProfileIdSchema,
    profileRevision: positiveIntegerSchema,
    baseProjectIntentRevision: positiveIntegerSchema.nullable(),
    baseLedgerRevision: positiveIntegerSchema.nullable(),
    latestProposalRevision: nonNegativeIntegerSchema,
    activeExecutionId: workerExecutionIdSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    const terminal = terminalPlanningCycleLifecycles.has(value.lifecycle);
    if (terminal && value.endedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Terminal cycles require an end time',
      });
    }
    if (!terminal && value.endedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Nonterminal cycles cannot have an end time',
      });
    }
    if (
      value.lifecycle === 'execution_active' &&
      value.activeExecutionId === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeExecutionId'],
        message: 'Active cycles require an execution ID',
      });
    }
    if (
      value.lifecycle !== 'execution_active' &&
      value.activeExecutionId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeExecutionId'],
        message: 'Only active cycles can have an execution ID',
      });
    }
  });
export type PlanningCycle = z.infer<typeof planningCycleSchema>;

export const planningTurnSchema = z
  .strictObject({
    id: planningTurnIdSchema,
    projectId: projectIdSchema,
    planningCycleId: planningCycleIdSchema,
    ordinal: positiveIntegerSchema,
    actor: z.enum(['human', 'pm']),
    message: boundedMessageSchema,
    launchState: planningTurnLaunchStateSchema.nullable(),
    executionId: workerExecutionIdSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .superRefine((value, context) => {
    if (value.actor === 'human' && value.launchState === null) {
      context.addIssue({
        code: 'custom',
        path: ['launchState'],
        message: 'Human turns require a launch state',
      });
    }
    if (value.actor === 'pm' && value.launchState !== null) {
      context.addIssue({
        code: 'custom',
        path: ['launchState'],
        message: 'PM turns do not own an execution launch state',
      });
    }
    if (
      value.actor === 'human' &&
      value.launchState === 'launch_pending' &&
      value.executionId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['executionId'],
        message: 'Launch-pending human turns cannot have an execution ID',
      });
    }
    if (
      value.actor === 'human' &&
      value.launchState === 'execution_bound' &&
      value.executionId === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['executionId'],
        message: 'Execution-bound human turns require an execution ID',
      });
    }
    if (value.actor === 'pm' && value.executionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['executionId'],
        message: 'PM turns require an execution ID',
      });
    }
  });
export type PlanningTurn = z.infer<typeof planningTurnSchema>;

export const planningQuestionSchema = z.strictObject({
  id: planningQuestionIdSchema,
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  turnId: planningTurnIdSchema,
  key: boundedKeySchema,
  prompt: boundedNarrativeSchema,
  rationale: boundedNarrativeSchema,
  choices: z.array(boundedNarrativeSchema).min(1).max(20).readonly().optional(),
});
export type PlanningQuestion = z.infer<typeof planningQuestionSchema>;

export const projectIntentFieldSchema = z.enum([
  'goal',
  'targetUsers',
  'desiredCapabilities',
  'constraints',
  'nonGoals',
  'successConditions',
  'rationale',
  'provenance',
]);
export type ProjectIntentField = z.infer<typeof projectIntentFieldSchema>;

export const planningProposalDiffSchema = z
  .strictObject({
    intentChanges: z.array(projectIntentFieldSchema).max(8).readonly(),
    recordChanges: z.strictObject({
      create: nonNegativeIntegerSchema.max(100),
      revise: nonNegativeIntegerSchema.max(100),
      reuse: nonNegativeIntegerSchema.max(100),
    }),
    relationshipChanges: z.strictObject({
      added: nonNegativeIntegerSchema.max(200),
      removed: nonNegativeIntegerSchema.max(200),
    }),
  })
  .superRefine((value, context) => {
    const fields = new Set(value.intentChanges);
    if (fields.size !== value.intentChanges.length) {
      context.addIssue({
        code: 'custom',
        path: ['intentChanges'],
        message: 'Intent change fields must be unique',
      });
    }
  });
export type PlanningProposalDiff = z.infer<typeof planningProposalDiffSchema>;

export const planningProposalSchema = z
  .strictObject({
    id: planningProposalIdSchema,
    projectId: projectIdSchema,
    planningCycleId: planningCycleIdSchema,
    revision: positiveIntegerSchema,
    lifecycle: planningProposalLifecycleSchema,
    baseProjectIntentRevision: positiveIntegerSchema.nullable(),
    baseLedgerRevision: positiveIntegerSchema.nullable(),
    summary: boundedNarrativeSchema,
    projectIntent: projectIntentContentSchema,
    records: z.array(proposedLedgerMemberSchema).max(100).readonly(),
    relationships: z
      .array(proposedLedgerRelationshipSchema)
      .max(200)
      .readonly(),
    diff: planningProposalDiffSchema,
    createdByTurnId: planningTurnIdSchema,
    createdByExecutionId: workerExecutionIdSchema,
    rejectionFeedback: boundedNarrativeSchema.nullable(),
    createdAt: isoTimestampSchema,
    decidedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    const result = pmProposalResultSchema.safeParse({
      kind: 'proposal',
      summary: value.summary,
      projectIntent: value.projectIntent,
      records: value.records,
      relationships: value.relationships,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, path: issue.path.slice(1) });
      }
    }
    const awaiting = value.lifecycle === 'awaiting_approval';
    const rejected = value.lifecycle === 'rejected';
    if (
      awaiting &&
      (value.decidedAt !== null || value.rejectionFeedback !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['decidedAt'],
        message: 'Awaiting proposals cannot have decision fields',
      });
    }
    if (!awaiting && value.decidedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['decidedAt'],
        message: 'Decided proposals require a decision time',
      });
    }
    if (rejected && value.rejectionFeedback === null) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionFeedback'],
        message: 'Rejected proposals require feedback',
      });
    }
    if (!rejected && value.rejectionFeedback !== null) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionFeedback'],
        message: 'Only rejected proposals can have rejection feedback',
      });
    }
  });
export type PlanningProposal = z.infer<typeof planningProposalSchema>;

export const planningCycleViewSchema = z
  .strictObject({
    cycle: planningCycleSchema,
    turns: z.array(planningTurnSchema).max(64).readonly(),
    questions: z.array(planningQuestionSchema).max(20).readonly(),
    proposals: z.array(planningProposalSchema).max(16).readonly(),
  })
  .superRefine((value, context) => {
    const projectId = value.cycle.projectId;
    const cycleId = value.cycle.id;
    const turnIds = new Set(value.turns.map((turn) => turn.id));
    const turnOrdinals = new Set<number>();
    value.turns.forEach((turn, index) => {
      if (turnOrdinals.has(turn.ordinal)) {
        context.addIssue({
          code: 'custom',
          path: ['turns', index, 'ordinal'],
          message: 'Planning turn ordinals must be unique',
        });
      }
      turnOrdinals.add(turn.ordinal);
    });
    if (turnIds.size !== value.turns.length) {
      context.addIssue({
        code: 'custom',
        path: ['turns'],
        message: 'Planning turn IDs must be unique',
      });
    }
    for (const [collection, records] of [
      ['turns', value.turns],
      ['questions', value.questions],
      ['proposals', value.proposals],
    ] as const) {
      records.forEach((record, index) => {
        if (
          record.projectId !== projectId ||
          record.planningCycleId !== cycleId
        ) {
          context.addIssue({
            code: 'custom',
            path: [collection, index],
            message:
              'Planning view children must match the cycle project and ID',
          });
        }
      });
    }
    value.questions.forEach((question, index) => {
      if (!turnIds.has(question.turnId)) {
        context.addIssue({
          code: 'custom',
          path: ['questions', index, 'turnId'],
          message: 'Planning questions must reference a turn in the view',
        });
      }
    });
    value.proposals.forEach((proposal, index) => {
      if (!turnIds.has(proposal.createdByTurnId)) {
        context.addIssue({
          code: 'custom',
          path: ['proposals', index, 'createdByTurnId'],
          message: 'Planning proposals must reference a turn in the view',
        });
      }
    });
    const questionIds = new Set(value.questions.map((question) => question.id));
    if (questionIds.size !== value.questions.length) {
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'Planning question IDs must be unique',
      });
    }
    const proposalIds = new Set(value.proposals.map((proposal) => proposal.id));
    const proposalRevisions = new Set(
      value.proposals.map((proposal) => proposal.revision),
    );
    if (proposalIds.size !== value.proposals.length) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'Planning proposal IDs must be unique',
      });
    }
    if (proposalRevisions.size !== value.proposals.length) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'Planning proposal revisions must be unique',
      });
    }
    const latestProposal = value.proposals.reduce<PlanningProposal | null>(
      (latest, proposal) =>
        latest === null || proposal.revision > latest.revision
          ? proposal
          : latest,
      null,
    );
    if (
      value.cycle.latestProposalRevision !== (latestProposal?.revision ?? 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['cycle', 'latestProposalRevision'],
        message: 'Latest proposal revision must match proposal history',
      });
    }
    if (
      value.cycle.lifecycle === 'awaiting_approval' &&
      (latestProposal === null ||
        latestProposal.lifecycle !== 'awaiting_approval')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'Awaiting-approval cycles require a latest proposal',
      });
    }
    if (
      value.cycle.lifecycle === 'approved' &&
      latestProposal?.lifecycle !== 'approved'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'Approved cycles require an approved latest proposal',
      });
    }
    if (
      value.cycle.lifecycle === 'proposal_rejected' &&
      latestProposal?.lifecycle !== 'rejected'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'Rejected cycles require a rejected latest proposal',
      });
    }
  });
export type PlanningCycleView = z.infer<typeof planningCycleViewSchema>;

export const projectIntentRevisionSchema = z.strictObject({
  id: projectIntentIdSchema,
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  content: projectIntentContentSchema,
  proposalId: planningProposalIdSchema,
  approvedBy: z.literal('human'),
  approvedAt: isoTimestampSchema,
});
export type ProjectIntentRevision = z.infer<typeof projectIntentRevisionSchema>;

export const ledgerRecordRevisionSchema = z.strictObject({
  recordId: ledgerRecordIdSchema,
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  content: ledgerRecordContentSchema,
  provenance: provenanceListSchema,
  proposalId: planningProposalIdSchema,
  approvedBy: z.literal('human'),
  approvedAt: isoTimestampSchema,
});
export type LedgerRecordRevision = z.infer<typeof ledgerRecordRevisionSchema>;

export const ledgerRevisionSchema = z.strictObject({
  id: ledgerIdSchema,
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  proposalId: planningProposalIdSchema,
  approvedBy: z.literal('human'),
  approvedAt: isoTimestampSchema,
});
export type LedgerRevision = z.infer<typeof ledgerRevisionSchema>;

export const approvedIntentLedgerSchema = z
  .strictObject({
    projectIntent: projectIntentRevisionSchema,
    ledger: ledgerRevisionSchema,
    records: z.array(ledgerRecordRevisionSchema).max(100).readonly(),
    relationships: z.array(ledgerRelationshipSchema).max(200).readonly(),
  })
  .superRefine((value, context) => {
    const projectId = value.projectIntent.projectId;
    if (value.ledger.projectId !== projectId) {
      context.addIssue({
        code: 'custom',
        path: ['ledger', 'projectId'],
        message: 'Intent and ledger projects must match',
      });
    }
    if (value.ledger.proposalId !== value.projectIntent.proposalId) {
      context.addIssue({
        code: 'custom',
        path: ['ledger', 'proposalId'],
        message: 'Intent and ledger proposal IDs must match',
      });
    }
    const recordIds = new Set<string>();
    value.records.forEach((record, index) => {
      if (recordIds.has(record.recordId)) {
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'recordId'],
          message: 'Ledger record IDs must be unique',
        });
      }
      recordIds.add(record.recordId);
      if (
        record.content.type === 'requirement' &&
        record.content.status === 'proposed'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'content', 'status'],
          message: 'Approved ledgers cannot contain proposed requirements',
        });
      }
    });
    const records = new Map(
      value.records.map((record) => [record.recordId, record] as const),
    );
    value.records.forEach((record, index) => {
      if (record.projectId !== projectId) {
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'projectId'],
          message: 'Ledger records must match the intent project',
        });
      }
      if (record.proposalId !== value.projectIntent.proposalId) {
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'proposalId'],
          message: 'Ledger record proposal must match the approved intent',
        });
      }
    });
    const relationshipKeys = new Set<string>();
    value.relationships.forEach((relationship, index) => {
      const relationshipKey = `${relationship.kind}:${relationship.fromRecordId}:${relationship.toRecordId}`;
      if (relationshipKeys.has(relationshipKey)) {
        context.addIssue({
          code: 'custom',
          path: ['relationships', index],
          message: 'Ledger relationships must be unique',
        });
      }
      relationshipKeys.add(relationshipKey);
      const from = records.get(relationship.fromRecordId);
      const to = records.get(relationship.toRecordId);
      if (from === undefined || to === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['relationships', index],
          message: 'Ledger relationship endpoints must be members',
        });
      } else if (
        (relationship.kind === 'constrains' &&
          (from.content.type !== 'decision' ||
            to.content.type !== 'requirement')) ||
        (relationship.kind !== 'constrains' &&
          (from.content.type !== 'requirement' ||
            to.content.type !== 'requirement'))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['relationships', index],
          message: 'Ledger relationship endpoint types are incompatible',
        });
      }
    });
  });
export type ApprovedIntentLedger = z.infer<typeof approvedIntentLedgerSchema>;

export const approvedPlanningOutcomeSchema = z
  .strictObject({
    planningCycle: planningCycleViewSchema,
    intentLedger: approvedIntentLedgerSchema,
  })
  .superRefine((value, context) => {
    const latestProposal =
      value.planningCycle.proposals.reduce<PlanningProposal | null>(
        (latest, proposal) =>
          latest === null || proposal.revision > latest.revision
            ? proposal
            : latest,
        null,
      );
    if (
      value.planningCycle.cycle.projectId !==
      value.intentLedger.projectIntent.projectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['intentLedger', 'projectIntent', 'projectId'],
        message: 'Approval outcome projects must match',
      });
    }
    if (
      value.planningCycle.cycle.lifecycle !== 'approved' ||
      value.planningCycle.cycle.endedAt === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle', 'cycle', 'lifecycle'],
        message: 'Approval requires an approved terminal cycle',
      });
    }
    if (latestProposal?.lifecycle !== 'approved') {
      context.addIssue({
        code: 'custom',
        path: ['planningCycle', 'proposals'],
        message: 'Approval requires an approved latest proposal',
      });
    }
    if (
      latestProposal !== null &&
      (value.intentLedger.projectIntent.proposalId !== latestProposal.id ||
        value.intentLedger.ledger.proposalId !== latestProposal.id)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['intentLedger'],
        message:
          'Approved intent and ledger proposal IDs must match the cycle proposal',
      });
    }
  });
export type ApprovedPlanningOutcome = z.infer<
  typeof approvedPlanningOutcomeSchema
>;

export const pmDiscoveryInputSchema = z.strictObject({
  conversation: z
    .array(
      z.strictObject({
        turnId: planningTurnIdSchema,
        actor: z.enum(['human', 'pm']),
        message: boundedMessageSchema,
      }),
    )
    .max(64)
    .readonly(),
  latestProposal: planningProposalSchema.nullable(),
  approvedIntentLedger: approvedIntentLedgerSchema.nullable(),
});
export type PmDiscoveryInput = z.infer<typeof pmDiscoveryInputSchema>;

export const pmDiscoveryAssignmentSchema = z
  .strictObject({
    kind: z.literal('pm_discovery'),
    projectId: projectIdSchema,
    outputSchema: z.literal(PM_DISCOVERY_REPORT_SCHEMA),
    planningCycleId: planningCycleIdSchema,
    humanTurnId: planningTurnIdSchema,
    expectedCycleRevision: nonNegativeIntegerSchema,
    expectedProposalRevision: positiveIntegerSchema,
    baseProjectIntentRevision: positiveIntegerSchema.nullable(),
    baseLedgerRevision: positiveIntegerSchema.nullable(),
    input: pmDiscoveryInputSchema,
  })
  .superRefine((value, context) => {
    if (
      !value.input.conversation.some(
        (turn) => turn.turnId === value.humanTurnId && turn.actor === 'human',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'conversation'],
        message: 'Assignment conversation must contain its human turn',
      });
    }
    if (
      value.input.latestProposal !== null &&
      (value.input.latestProposal.projectId !== value.projectId ||
        value.input.latestProposal.planningCycleId !== value.planningCycleId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'latestProposal'],
        message: 'Latest proposal must match the assignment project and cycle',
      });
    }
    if (
      value.input.approvedIntentLedger !== null &&
      value.input.approvedIntentLedger.projectIntent.projectId !==
        value.projectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'approvedIntentLedger'],
        message: 'Approved intent ledger must match the assignment project',
      });
    }
    const approved = value.input.approvedIntentLedger;
    if (
      value.baseProjectIntentRevision !==
      (approved?.projectIntent.revision ?? null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseProjectIntentRevision'],
        message:
          'Base project intent revision must match the approved intent ledger',
      });
    }
    if (value.baseLedgerRevision !== (approved?.ledger.revision ?? null)) {
      context.addIssue({
        code: 'custom',
        path: ['baseLedgerRevision'],
        message: 'Base ledger revision must match the approved intent ledger',
      });
    }
    const latestProposal = value.input.latestProposal;
    if (latestProposal === null && value.expectedProposalRevision !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['expectedProposalRevision'],
        message:
          'Expected proposal revision must be one without a latest proposal',
      });
    }
    if (
      latestProposal !== null &&
      value.expectedProposalRevision !== latestProposal.revision + 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedProposalRevision'],
        message: 'Expected proposal revision must follow the latest proposal',
      });
    }
    if (
      latestProposal !== null &&
      (latestProposal.baseProjectIntentRevision !==
        value.baseProjectIntentRevision ||
        latestProposal.baseLedgerRevision !== value.baseLedgerRevision)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'latestProposal'],
        message: 'Latest proposal must match the assignment canonical base',
      });
    }
  });
export type PmDiscoveryAssignment = z.infer<typeof pmDiscoveryAssignmentSchema>;

export const pmDiscoveryReportSchema = z.strictObject({
  schema: z.literal(PM_DISCOVERY_REPORT_SCHEMA),
  planningCycleId: planningCycleIdSchema,
  humanTurnId: planningTurnIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  expectedProposalRevision: positiveIntegerSchema,
  assistantMessage: boundedNarrativeSchema,
  result: z.discriminatedUnion('kind', [
    pmQuestionResultSchema,
    pmProposalResultSchema,
  ]),
});
export type PmDiscoveryReport = z.infer<typeof pmDiscoveryReportSchema>;
