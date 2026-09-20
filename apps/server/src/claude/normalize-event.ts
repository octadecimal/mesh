import {
  lifecycleStateSchema,
  idSchema,
  sessionActivitySchema,
  sessionUsageSchema,
  type LifecycleState,
  type SessionActivity,
  type SessionUsage,
} from '@mesh-session-platform/contracts';

import type { DriverEvent } from './driver.js';

export type DriverEventDraft =
  | { type: 'message.assistant'; payload: { text: string } }
  | {
      type: 'tool.requested';
      payload: { toolCallId: string; name: string; input: unknown };
    }
  | {
      type: 'tool.completed';
      payload: { toolCallId: string; output: unknown; isError: boolean };
    }
  | {
      type: 'permission.requested';
      payload: {
        permissionId: string;
        toolCallId?: string;
        name: string;
        input: unknown;
      };
    }
  | {
      type: 'session.status';
      payload: { from: LifecycleState; to: LifecycleState; reason?: string };
    }
  | {
      type: 'session.error';
      payload: { code: string; message: string; details?: unknown };
    }
  | { type: 'session.activity'; payload: SessionActivity }
  | { type: 'session.usage'; payload: SessionUsage };

export interface UnsupportedClaudeCapability {
  code: 'unsupported_claude_capability';
  capability: string;
}

export type NormalizedDriverEvent =
  | { kind: 'event'; event: DriverEventDraft }
  | { kind: 'unsupported'; error: UnsupportedClaudeCapability; raw: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLifecycleState = (value: unknown): value is LifecycleState =>
  lifecycleStateSchema.safeParse(value).success;

const unsupported = (
  raw: unknown,
  capability: string,
): NormalizedDriverEvent => ({
  kind: 'unsupported',
  error: { code: 'unsupported_claude_capability', capability },
  raw,
});

export const normalizeDriverEvent = (raw: unknown): NormalizedDriverEvent => {
  if (!isObject(raw) || typeof raw.kind !== 'string')
    return unsupported(raw, 'malformed_event');

  switch (raw.kind) {
    case 'text_delta':
    case 'text_completed':
      return typeof raw.text === 'string'
        ? {
            kind: 'event',
            event: { type: 'message.assistant', payload: { text: raw.text } },
          }
        : unsupported(raw, raw.kind);
    case 'activity': {
      const sourceEventId = idSchema.safeParse(raw.sourceEventId);
      const activity = sessionActivitySchema.safeParse(raw.activity);
      return sourceEventId.success && activity.success
        ? {
            kind: 'event',
            event: { type: 'session.activity', payload: activity.data },
          }
        : unsupported(raw, raw.kind);
    }
    case 'usage': {
      const sourceEventId = idSchema.safeParse(raw.sourceEventId);
      const usage = sessionUsageSchema.safeParse(raw.usage);
      return sourceEventId.success && usage.success
        ? {
            kind: 'event',
            event: { type: 'session.usage', payload: usage.data },
          }
        : unsupported(raw, raw.kind);
    }
    case 'tool_requested': {
      const { toolCallId, name, input } = raw;
      return typeof toolCallId === 'string' &&
        typeof name === 'string' &&
        'input' in raw
        ? {
            kind: 'event',
            event: {
              type: 'tool.requested',
              payload: { toolCallId, name, input },
            },
          }
        : unsupported(raw, raw.kind);
    }
    case 'tool_completed':
      return typeof raw.toolCallId === 'string' &&
        'output' in raw &&
        typeof raw.isError === 'boolean'
        ? {
            kind: 'event',
            event: {
              type: 'tool.completed',
              payload: {
                toolCallId: raw.toolCallId,
                output: raw.output,
                isError: raw.isError,
              },
            },
          }
        : unsupported(raw, raw.kind);
    case 'permission_requested': {
      const { permissionId, toolCallId, name, input } = raw;
      return typeof permissionId === 'string' &&
        typeof name === 'string' &&
        'input' in raw &&
        (toolCallId === undefined || typeof toolCallId === 'string')
        ? {
            kind: 'event',
            event: {
              type: 'permission.requested',
              payload: {
                permissionId,
                toolCallId:
                  typeof toolCallId === 'string' ? toolCallId : undefined,
                name,
                input,
              },
            },
          }
        : unsupported(raw, raw.kind);
    }
    case 'status': {
      const { from, to, reason } = raw;
      return isLifecycleState(from) &&
        isLifecycleState(to) &&
        (reason === undefined || typeof reason === 'string')
        ? {
            kind: 'event',
            event: {
              type: 'session.status',
              payload: {
                from,
                to,
                reason: typeof reason === 'string' ? reason : undefined,
              },
            },
          }
        : unsupported(raw, raw.kind);
    }
    case 'limit':
      return typeof raw.capability === 'string' &&
        typeof raw.message === 'string' &&
        (raw.resetAt === undefined || typeof raw.resetAt === 'string')
        ? {
            kind: 'event',
            event: {
              type: 'session.error',
              payload: {
                code: 'subscription_limit',
                message: raw.message,
                details: {
                  capability: raw.capability,
                  ...(typeof raw.resetAt === 'string'
                    ? { resetAt: raw.resetAt }
                    : {}),
                },
              },
            },
          }
        : unsupported(raw, raw.kind);
    case 'terminal_error':
      return typeof raw.code === 'string' && typeof raw.message === 'string'
        ? {
            kind: 'event',
            event: {
              type: 'session.error',
              payload: {
                code: raw.code,
                message: raw.message,
                details: raw.details,
              },
            },
          }
        : unsupported(raw, raw.kind);
    case 'malformed':
      return unsupported(raw.raw, 'malformed_event');
    default:
      return unsupported(raw, raw.kind);
  }
};

export const isDriverEvent = (value: unknown): value is DriverEvent =>
  normalizeDriverEvent(value).kind === 'event';
