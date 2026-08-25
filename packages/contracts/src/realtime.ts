import { z } from 'zod';

import { idSchema, isoTimestampSchema } from './domain.js';
import { sessionEventSchema } from './events.js';
import { sessionSnapshotSchema } from './http.js';
import { projectEventSchema } from './project-events.js';
import { protocolVersionSchema } from './protocol.js';

const serverMessage = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) =>
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal(type),
    payload,
  });

export const subscribeFrameSchema = z.object({
  protocolVersion: protocolVersionSchema,
  type: z.literal('subscribe'),
  cursors: z.record(idSchema, z.number().int().nonnegative()),
  projectCursors: z
    .record(idSchema, z.number().int().nonnegative())
    .optional(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  serverMessage('snapshot', sessionSnapshotSchema),
  serverMessage('events', z.object({ events: z.array(sessionEventSchema) })),
  serverMessage(
    'assistant.delta',
    z.object({ sessionId: idSchema, text: z.string() }),
  ),
  serverMessage(
    'connection.health',
    z.object({
      status: z.enum(['connected', 'degraded', 'disconnected']),
      observedAt: isoTimestampSchema,
    }),
  ),
  serverMessage(
    'resync.required',
    z.object({ sessionId: idSchema, reason: z.string().min(1) }),
  ),
  serverMessage('project.event', z.object({ event: projectEventSchema })),
  serverMessage(
    'project.resync_required',
    z.object({ projectId: idSchema, reason: z.string().min(1) }),
  ),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;
