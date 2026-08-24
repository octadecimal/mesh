import { z } from 'zod';

import { idSchema, permissionModeSchema, savedLayoutSchema } from './domain.js';

export const discoveryCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('projects.discover'), payload: z.object({}) }),
  z.object({
    type: z.literal('sessions.discover'),
    payload: z.object({ projectId: idSchema.optional() }),
  }),
]);

export const mutatingCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.create'),
    payload: z.object({
      projectId: idSchema,
      workspaceId: idSchema,
      title: z.string().min(1),
      permissionMode: permissionModeSchema,
    }),
  }),
  z.object({
    type: z.literal('session.resume'),
    payload: z.object({ sessionId: idSchema }),
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
    type: z.literal('session.history'),
    payload: z.object({
      sessionId: idSchema,
      afterSequence: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal('session.diagnostics'),
    payload: z.object({ sessionId: idSchema }),
  }),
]);

export const commandSchema = z.union([
  discoveryCommandSchema,
  mutatingCommandSchema,
  readCommandSchema,
]);
export const commandEnvelopeSchema = z.object({
  idempotencyKey: idSchema,
  command: mutatingCommandSchema,
});

export type DiscoveryCommand = z.infer<typeof discoveryCommandSchema>;
export type MutatingCommand = z.infer<typeof mutatingCommandSchema>;
export type ReadCommand = z.infer<typeof readCommandSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandEnvelope<T extends MutatingCommand = MutatingCommand> = Omit<
  z.infer<typeof commandEnvelopeSchema>,
  'command'
> & { command: T };
