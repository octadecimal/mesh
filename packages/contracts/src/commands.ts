import { z } from 'zod';

import {
  idSchema,
  permissionModeSchema,
  savedLayoutSchema,
  taskActorSchema,
  taskLifecycleStateSchema,
  taskPrioritySchema,
} from './domain.js';
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
} from './developer-execution.js';
import { qaReportInputSchema, reviewPolicySchema } from './qa-execution.js';
import { protocolVersionSchema } from './protocol.js';

export const discoveryCommandSchema = z.discriminatedUnion('type', [
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal('projects.discover'),
    payload: z.object({}),
  }),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal('sessions.discover'),
    payload: z.object({ projectId: idSchema.optional() }),
  }),
]);

const sessionWorkspaceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shared'),
    path: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('worktree'),
    repositoryPath: z.string().trim().min(1),
    path: z.string().trim().min(1),
    branch: z.string().trim().min(1),
    startPoint: z.string().trim().min(1),
  }),
]);

const sessionCreatePayloadSchema = z.union([
  z.object({
    projectId: idSchema,
    workspaceId: idSchema,
    title: z.string().min(1),
    permissionMode: permissionModeSchema,
  }),
  z.object({
    projectId: idSchema,
    title: z.string().min(1),
    permissionMode: permissionModeSchema,
    workspace: z.object({
      type: z.literal('shared'),
      path: z.string().trim().min(1),
    }),
  }),
  z.object({
    projectId: idSchema,
    title: z.string().min(1),
    permissionMode: permissionModeSchema,
    workspace: z.object({
      type: z.literal('worktree'),
      repositoryPath: z.string().trim().min(1),
      path: z.string().trim().min(1),
      branch: z.string().trim().min(1),
      startPoint: z.string().trim().min(1),
    }),
  }),
]);

const expectedRevisionSchema = z.number().int().positive();
const humanActorSchema = taskActorSchema.extend({ type: z.literal('human') });
const developerAgentActorSchema = taskActorSchema.extend({
  type: z.literal('agent'),
});
const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
    priority: taskPrioritySchema.optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    notes: z.string().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export const projectCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project.import'),
    payload: z.object({
      repositoryPath: z.string().trim().min(1),
      displayName: z.string().trim().min(1).optional(),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('project.rename'),
    payload: z.object({
      projectId: idSchema,
      expectedRevision: expectedRevisionSchema,
      displayName: z.string().trim().min(1),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('project.archive'),
    payload: z.object({
      projectId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('project.restore'),
    payload: z.object({
      projectId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('project.developer_instructions.update'),
    payload: z.object({
      projectId: idSchema,
      expectedRevision: expectedRevisionSchema,
      content: z.string(),
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('project.qa_configuration.update'),
    payload: z.object({
      projectId: idSchema,
      expectedRevision: expectedRevisionSchema,
      content: z.string(),
      reviewPolicy: reviewPolicySchema,
      actor: humanActorSchema,
    }),
  }),
]);

export const taskCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.create'),
    payload: z.object({
      projectId: idSchema,
      title: z.string().trim().min(1),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
      priority: taskPrioritySchema.optional(),
      labels: z.array(z.string().trim().min(1)).optional(),
      notes: z.string().optional(),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.edit'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      patch: taskPatchSchema,
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.reorder'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      rank: z.string().trim().min(1),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.block'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      reason: z.string().trim().min(1),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.unblock'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      reason: z.string().trim().min(1),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.transition'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      nextState: taskLifecycleStateSchema,
      reason: z.string().trim().min(1).optional(),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.attempt.launch'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      title: z.string().trim().min(1),
      permissionMode: permissionModeSchema,
      workspace: sessionWorkspaceSchema,
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.attempt.link'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      sessionId: idSchema,
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.attempt.unlink'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      attemptId: idSchema,
      reason: z.string().trim().min(1),
      actor: taskActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.launch'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      title: z.string().trim().min(1),
      permissionMode: permissionModeSchema,
      workspace: sessionWorkspaceSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.submit_review'),
    payload: z.object({
      capability: z.string().trim().min(1),
      expectedRevision: expectedRevisionSchema,
      report: developerCompletionReportSchema,
      actor: developerAgentActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.block'),
    payload: z.object({
      capability: z.string().trim().min(1),
      expectedRevision: expectedRevisionSchema,
      report: developerBlockerReportSchema,
      actor: developerAgentActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.accept'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.reject_resume'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      feedback: z.string().trim().min(1),
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.reject_new'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      feedback: z.string().trim().min(1),
      title: z.string().trim().min(1),
      permissionMode: permissionModeSchema,
      workspace: sessionWorkspaceSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.unblock_resume'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      feedback: z.string().trim().min(1),
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.developer.unblock_new'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      feedback: z.string().trim().min(1),
      title: z.string().trim().min(1),
      permissionMode: permissionModeSchema,
      workspace: sessionWorkspaceSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.qa.launch'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.qa.submit_verdict'),
    payload: z.object({
      capability: z.string().trim().min(1),
      expectedRevision: expectedRevisionSchema,
      report: qaReportInputSchema,
      actor: developerAgentActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.qa.repair_interrupted'),
    payload: z.object({
      taskId: idSchema,
      cycleId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.review_automation.enable'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: humanActorSchema,
    }),
  }),
  z.object({
    type: z.literal('task.review_automation.pause'),
    payload: z.object({
      taskId: idSchema,
      expectedRevision: expectedRevisionSchema,
      actor: humanActorSchema,
    }),
  }),
]);

export const mutatingCommandSchema = z.union([
  z.object({
    type: z.literal('session.create'),
    payload: sessionCreatePayloadSchema,
  }),
  z.object({
    type: z.literal('session.resume'),
    payload: z.object({
      sessionId: idSchema,
      workspaceId: idSchema,
      permissionMode: permissionModeSchema,
    }),
  }),
  z.object({
    type: z.literal('session.prompt'),
    payload: z.object({ sessionId: idSchema, prompt: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('session.interrupt'),
    payload: z.object({ sessionId: idSchema }),
  }),
  z.object({
    type: z.literal('permission.decide'),
    payload: z.object({
      permissionId: idSchema,
      decision: z.enum(['approve', 'deny']),
    }),
  }),
  z.object({
    type: z.literal('session.archive'),
    payload: z.object({ sessionId: idSchema }),
  }),
  z.object({
    type: z.literal('session.delete'),
    payload: z.object({ sessionId: idSchema, confirmed: z.literal(true) }),
  }),
  z.object({ type: z.literal('layout.save'), payload: savedLayoutSchema }),
  projectCommandSchema,
  taskCommandSchema,
]);

export const readCommandSchema = z.discriminatedUnion('type', [
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal('session.history'),
    payload: z.object({
      sessionId: idSchema,
      afterSequence: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal('session.diagnostics'),
    payload: z.object({ sessionId: idSchema }),
  }),
]);

export const commandEnvelopeSchema = z.object({
  protocolVersion: protocolVersionSchema,
  idempotencyKey: idSchema,
  command: mutatingCommandSchema,
});
export const commandSchema = z.union([
  discoveryCommandSchema,
  readCommandSchema,
  commandEnvelopeSchema,
]);

export type DiscoveryCommand = z.infer<typeof discoveryCommandSchema>;
export type MutatingCommand = z.infer<typeof mutatingCommandSchema>;
export type ReadCommand = z.infer<typeof readCommandSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandEnvelope<T extends MutatingCommand = MutatingCommand> = Omit<
  z.infer<typeof commandEnvelopeSchema>,
  'command'
> & { command: T };
