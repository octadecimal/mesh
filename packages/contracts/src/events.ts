import { z } from 'zod';

import {
  idSchema,
  isoTimestampSchema,
  lifecycleStateSchema,
} from './domain.js';
import { protocolVersionSchema } from './protocol.js';

export const capabilityErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.unknown().optional(),
});

export const permissionRequestSchema = z.object({
  permissionId: idSchema,
  toolCallId: idSchema.optional(),
  name: z.string().trim().min(1),
  input: z.unknown(),
  actions: z.array(z.enum(['approve', 'deny'])).min(1),
});

export const permissionResolutionSchema = z.object({
  permissionId: idSchema,
  decision: z.enum(['approved', 'denied', 'expired']),
  resolvedAt: isoTimestampSchema,
});

export const sessionActivitySchema = z.object({
  kind: z.enum([
    'initialization',
    'tool_progress',
    'hook',
    'subagent',
    'retry',
    'compaction',
    'status',
  ]),
  summary: z.string().trim().min(1),
  toolCallId: idSchema.optional(),
  elapsedSeconds: z.number().finite().nonnegative().optional(),
  details: z.unknown().optional(),
});

const reportedMetricSchema = z.number().finite().nonnegative();
const reportedTokenSchema = reportedMetricSchema.int();

export const sessionUsageSchema = z.object({
  scope: z.enum(['turn', 'query']).optional(),
  model: z.string().trim().min(1).optional(),
  inputTokens: reportedTokenSchema.optional(),
  outputTokens: reportedTokenSchema.optional(),
  cacheReadTokens: reportedTokenSchema.optional(),
  cacheCreationTokens: reportedTokenSchema.optional(),
  contextWindow: reportedTokenSchema.optional(),
  contextTokens: reportedTokenSchema.optional(),
  durationMs: reportedMetricSchema.optional(),
});

const event = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) =>
  z.object({
    protocolVersion: protocolVersionSchema,
    id: idSchema,
    sessionId: idSchema,
    sequence: z.number().int().positive(),
    occurredAt: isoTimestampSchema,
    type: z.literal(type),
    payload,
  });

export const sessionEventSchema = z.discriminatedUnion('type', [
  event('message.user', z.object({ text: z.string() })),
  event('message.assistant', z.object({ text: z.string() })),
  event(
    'tool.requested',
    z.object({ toolCallId: idSchema, name: z.string(), input: z.unknown() }),
  ),
  event(
    'tool.completed',
    z.object({
      toolCallId: idSchema,
      output: z.unknown(),
      isError: z.boolean(),
    }),
  ),
  event('permission.requested', permissionRequestSchema),
  event('permission.resolved', permissionResolutionSchema),
  event('session.activity', sessionActivitySchema),
  event('session.usage', sessionUsageSchema),
  event(
    'session.status',
    z.object({
      from: lifecycleStateSchema,
      to: lifecycleStateSchema,
      reason: z.string().optional(),
    }),
  ),
  event('session.error', capabilityErrorSchema),
  event(
    'diagnostic.recorded',
    z.object({
      diagnosticId: idSchema,
      normalizedEventId: idSchema.optional(),
    }),
  ),
]);

export type CapabilityError = z.infer<typeof capabilityErrorSchema>;
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
export type PermissionResolution = z.infer<typeof permissionResolutionSchema>;
export type SessionActivity = z.infer<typeof sessionActivitySchema>;
export type SessionUsage = z.infer<typeof sessionUsageSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
