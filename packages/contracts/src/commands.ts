import { z } from 'zod';

import { idSchema, permissionModeSchema, savedLayoutSchema } from './domain.js';
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

const mutatingCommandSchema = z.discriminatedUnion('type', [
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
