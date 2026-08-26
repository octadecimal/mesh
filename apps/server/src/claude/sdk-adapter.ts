import { randomUUID } from 'node:crypto';

import {
  createSdkMcpServer,
  listSessions,
  query,
  tool,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  developerBlockerReportInputSchema,
  developerCompletionReportInputSchema,
} from '@mesh-session-platform/contracts';

import type { DeveloperRuntimeControls } from './driver.js';
import {
  UnsupportedSdkCapabilityError,
  type SdkFacade,
  type SdkPermissionDecision,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkStreamEvent,
} from './sdk-driver.js';

class AsyncPromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<SDKUserMessage>) => void
  > = [];
  private ended = false;

  push(prompt: string): void {
    if (this.ended) throw new Error('Claude query is closed');
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.values.push(message);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
          this.waiters.push(resolve),
        );
      },
    };
  }
}

const permissionResult = (
  decision: SdkPermissionDecision,
  input: Record<string, unknown>,
): PermissionResult => {
  if (decision === 'approve') return { behavior: 'allow', updatedInput: input };
  return {
    behavior: 'deny',
    message: 'Denied by Mesh session permission policy',
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const safeDeveloperControlErrorCodes = new Set([
  'invalid_input',
  'developer_control_failed',
  'developer_capability_invalid',
  'developer_execution_outcome_invalid',
  'project_not_found',
  'project_archived',
  'task_not_found',
  'task_revision_conflict',
  'task_blocked',
  'task_transition_invalid',
  'task_transition_unauthorized',
  'command_reconciliation_required',
]);

const developerControlFailure = (error: unknown) => {
  const record = asRecord(error);
  const candidate =
    typeof record?.code === 'string'
      ? record.code
      : typeof error === 'string'
        ? error
        : undefined;
  const code =
    candidate && safeDeveloperControlErrorCodes.has(candidate)
      ? candidate
      : 'developer_control_failed';
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', code }),
      },
    ],
    isError: true,
  };
};

const developerControlSuccess = (
  status: 'submitted_for_review' | 'blocked',
) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ status }) }],
});

const createDeveloperMcpServer = (controls: DeveloperRuntimeControls) =>
  createSdkMcpServer({
    name: 'mesh_developer',
    version: '1',
    alwaysLoad: true,
    tools: [
      tool(
        'submit_for_review',
        'Submit completed work and evidence for human review.',
        developerCompletionReportInputSchema.shape,
        async (input) => {
          const parsed = developerCompletionReportInputSchema.safeParse(input);
          if (!parsed.success) return developerControlFailure('invalid_input');
          try {
            await controls.submitForReview(parsed.data);
            return developerControlSuccess('submitted_for_review');
          } catch (error) {
            return developerControlFailure(error);
          }
        },
      ),
      tool(
        'mark_blocked',
        'Report why work cannot safely continue and request human action.',
        developerBlockerReportInputSchema.shape,
        async (input) => {
          const parsed = developerBlockerReportInputSchema.safeParse(input);
          if (!parsed.success) return developerControlFailure('invalid_input');
          try {
            await controls.markBlocked(parsed.data);
            return developerControlSuccess('blocked');
          } catch (error) {
            return developerControlFailure(error);
          }
        },
      ),
    ],
  });

const messageEvents = (message: SDKMessage): SdkStreamEvent[] => {
  if (message.type === 'system' && message.subtype === 'init') {
    return [
      {
        kind: 'started',
        sessionId: message.session_id,
        apiKeySource: message.apiKeySource,
      },
    ];
  }

  if (message.type === 'assistant') {
    const events: SdkStreamEvent[] = [];
    if (message.error) {
      const limit =
        message.error === 'rate_limit' || message.error === 'billing_error';
      events.push(
        limit
          ? {
              kind: 'limit',
              capability: message.error,
              message: `Claude ${message.error}`,
            }
          : {
              kind: 'error',
              code: message.error,
              message: `Claude ${message.error}`,
            },
      );
    }
    for (const block of message.message.content) {
      const value = asRecord(block);
      if (!value || typeof value.type !== 'string') {
        events.push({ kind: 'malformed', raw: block });
      } else if (value.type === 'text' && typeof value.text === 'string') {
        events.push({ kind: 'assistant_text', text: value.text });
      } else if (
        (value.type === 'tool_use' || value.type === 'server_tool_use') &&
        typeof value.id === 'string' &&
        typeof value.name === 'string'
      ) {
        events.push({
          kind: 'tool_requested',
          toolCallId: value.id,
          name: value.name,
          input: value.input,
        });
      }
    }
    return events;
  }

  if (message.type === 'user' && Array.isArray(message.message.content)) {
    return message.message.content.flatMap((block): SdkStreamEvent[] => {
      const value = asRecord(block);
      if (
        !value ||
        value.type !== 'tool_result' ||
        typeof value.tool_use_id !== 'string'
      )
        return [];
      return [
        {
          kind: 'tool_completed',
          toolCallId: value.tool_use_id,
          output: 'content' in value ? value.content : message.tool_use_result,
          isError: value.is_error === true,
        },
      ];
    });
  }

  if (message.type === 'stream_event') {
    const event = asRecord(message.event);
    const delta = event ? asRecord(event.delta) : undefined;
    return event?.type === 'content_block_delta' &&
      delta?.type === 'text_delta' &&
      typeof delta.text === 'string'
      ? [{ kind: 'assistant_delta', text: delta.text }]
      : [];
  }

  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info;
    if (info.status === 'allowed') return [];
    const resetAt = info.resetsAt
      ? new Date(info.resetsAt).toISOString()
      : undefined;
    const reset = resetAt ? `; resets at ${resetAt}` : '';
    return [
      {
        kind: 'limit',
        capability: info.rateLimitType ?? 'subscription',
        message: `Claude subscription limit ${info.status}${reset}`,
        resetAt,
      },
    ];
  }

  if (message.type === 'result') {
    if (message.subtype === 'success') return [{ kind: 'completed' }];
    if (
      message.subtype === 'error_max_turns' ||
      message.subtype === 'error_max_budget_usd'
    ) {
      return [
        {
          kind: 'limit',
          capability: message.subtype,
          message: message.errors.join('; ') || message.subtype,
        },
        { kind: 'completed' },
      ];
    }
    return [
      {
        kind: 'error',
        code: message.subtype,
        message: message.errors.join('; ') || message.subtype,
        details: { terminalReason: message.terminal_reason },
      },
      { kind: 'completed' },
    ];
  }

  return [];
};

class ClaudeSdkQuery implements SdkQuery {
  constructor(
    readonly sessionId: string,
    private readonly sdkQuery: Query,
    private readonly prompts: AsyncPromptQueue,
  ) {}

  async *events(): AsyncIterable<SdkStreamEvent> {
    for await (const message of this.sdkQuery) yield* messageEvents(message);
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  async interrupt(): Promise<void> {
    if (typeof this.sdkQuery.interrupt !== 'function') {
      throw new UnsupportedSdkCapabilityError('interrupt');
    }
    await this.sdkQuery.interrupt();
  }

  close(): void {
    this.prompts.close();
    this.sdkQuery.close();
  }
}

export const createClaudeSdkFacade = (): SdkFacade => ({
  listSessions: async ({ cwd }) =>
    (await listSessions({ dir: cwd })).map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
    })),
  startQuery: (options: SdkQueryOptions) => {
    const prompts = new AsyncPromptQueue();
    const sessionId = options.resume ?? randomUUID();
    const onPermission = options.onPermission;
    const canUseTool: CanUseTool | undefined = onPermission
      ? async (toolName, input, permissionOptions) =>
          permissionResult(
            await onPermission({
              requestId: permissionOptions.requestId,
              toolUseId: permissionOptions.toolUseID,
              toolName,
              input,
            }),
            input,
          )
      : undefined;
    const sdkQuery = query({
      prompt: prompts,
      options: {
        cwd: options.cwd,
        title: options.title,
        resume: options.resume,
        sessionId: options.resume ? undefined : sessionId,
        includePartialMessages: true,
        permissionMode: 'default',
        ...(canUseTool ? { canUseTool } : {}),
        ...(options.developer
          ? {
              mcpServers: {
                mesh_developer: createDeveloperMcpServer(
                  options.developer.controls,
                ),
              },
            }
          : {}),
      },
    });
    if (
      typeof sdkQuery.interrupt !== 'function' ||
      typeof sdkQuery.close !== 'function'
    ) {
      sdkQuery.close?.();
      throw new UnsupportedSdkCapabilityError('streaming_control');
    }
    return new ClaudeSdkQuery(sessionId, sdkQuery, prompts);
  },
});
