import { z } from 'zod';

import {
  domainEventSchema,
  projectEventCursorsSchema,
  runtimeEventSchema,
} from './events';
import { projectIdSchema } from './ids';
import { v2ProtocolVersionSchema } from './http';

export const clientRealtimeMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('v2.subscribe'),
    protocolVersion: v2ProtocolVersionSchema,
    projectId: projectIdSchema,
    cursors: projectEventCursorsSchema,
  }),
]);
export type ClientRealtimeMessage = z.infer<typeof clientRealtimeMessageSchema>;

export const serverRealtimeMessageSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('v2.subscribed'),
      protocolVersion: v2ProtocolVersionSchema,
      projectId: projectIdSchema,
      cursors: projectEventCursorsSchema,
    }),
    z.strictObject({
      type: z.literal('v2.domain_event'),
      protocolVersion: v2ProtocolVersionSchema,
      projectId: projectIdSchema,
      event: domainEventSchema,
    }),
    z.strictObject({
      type: z.literal('v2.runtime_event'),
      protocolVersion: v2ProtocolVersionSchema,
      projectId: projectIdSchema,
      event: runtimeEventSchema,
    }),
    z.strictObject({
      type: z.literal('v2.resync_required'),
      protocolVersion: v2ProtocolVersionSchema,
      projectId: projectIdSchema,
      reason: z.enum([
        'invalid_payload',
        'project_mismatch',
        'retained_gap',
        'non_contiguous_buffer',
      ]),
    }),
  ])
  .superRefine((value, context) => {
    if (
      (value.type === 'v2.domain_event' || value.type === 'v2.runtime_event') &&
      value.projectId !== value.event.projectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['event', 'projectId'],
        message: 'Realtime event project must match the message project',
      });
    }
  });
export type ServerRealtimeMessage = z.infer<typeof serverRealtimeMessageSchema>;
