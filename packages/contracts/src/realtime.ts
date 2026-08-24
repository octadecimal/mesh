import { z } from 'zod';

import { idSchema, isoTimestampSchema } from './domain.js';
import { sessionEventSchema } from './events.js';
import { sessionSnapshotSchema } from './http.js';

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), payload: sessionSnapshotSchema }),
  z.object({
    type: z.literal('events'),
    payload: z.object({ events: z.array(sessionEventSchema) }),
  }),
  z.object({
    type: z.literal('connection.health'),
    payload: z.object({
      status: z.enum(['connected', 'degraded', 'disconnected']),
      observedAt: isoTimestampSchema,
    }),
  }),
  z.object({
    type: z.literal('resync.required'),
    payload: z.object({ sessionId: idSchema, reason: z.string().min(1) }),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
