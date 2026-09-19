import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
  idSchema,
  projectPlanProposalInputSchema,
} from '@mesh-session-platform/contracts';
import { z } from 'zod';

import type {
  DeveloperRuntimeControls,
  PmRuntimeConfiguration,
  RoleControlServer,
} from './driver.js';
import {
  PM_AVAILABLE_TOOLS,
  PM_BUILTIN_TOOLS,
  PM_DISALLOWED_TOOLS,
} from '../domain/planning-policy.js';
import {
  QaWorkspaceReader,
  workspaceObjectIdentity,
} from '../platform/qa-workspace-reader.js';
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

const validToolCallId = (value: string) => {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

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

const createRoleMcpServer = (server: RoleControlServer) =>
  createSdkMcpServer({
    name: server.name,
    version: server.version,
    alwaysLoad: true,
    tools: server.tools.map((control) =>
      tool(
        control.name,
        control.description,
        control.inputSchema,
        control.execute,
      ),
    ),
  });

const safePmControlErrorCodes = new Set([
  'planning_capability_invalid',
  'planning_capability_mismatch',
  'planning_capability_expired',
  'planning_capability_in_use',
  'planning_proposal_invalid',
  'planning_submission_failed',
]);

type PmControlProblem = {
  code: string;
  path: Array<string | number>;
  message: string;
};

const pmControlFailure = (
  error: unknown,
  problems?: readonly PmControlProblem[],
) => {
  const record = asRecord(error);
  const candidate =
    typeof record?.code === 'string'
      ? record.code
      : typeof error === 'string'
        ? error
        : undefined;
  const code =
    candidate && safePmControlErrorCodes.has(candidate)
      ? candidate
      : 'planning_submission_failed';
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'error',
          code,
          ...(problems && problems.length > 0 ? { problems } : {}),
        }),
      },
    ],
    isError: true,
  };
};

const pmWorkspaceReadSchema = z.object({
  path: z.string().trim().min(1).max(1_024),
});

const pmWorkspaceGlobSchema = z.object({
  pattern: z.string().trim().min(1).max(1_024),
  path: z.string().trim().min(1).max(1_024).default('.'),
});

const pmWorkspaceSearchSchema = z.object({
  query: z.string().trim().min(1).max(1_024),
  path: z.string().trim().min(1).max(1_024).default('.'),
});

type PmWorkspaceContext = {
  reader: QaWorkspaceReader;
  root: string;
  signal: AbortSignal;
};

const pmWorkspaceContext = (
  cwd: string | undefined,
  signal: AbortSignal,
): PmWorkspaceContext => {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new Error(
      'PM runtime requires an explicit repository working directory.',
    );
  }
  const lexicalRoot = resolve(cwd);
  const root = realpathSync(lexicalRoot);
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error('PM runtime working directory must be a directory.');
  }
  return {
    reader: new QaWorkspaceReader(
      {},
      {
        lexicalRoot,
        root,
        rootObjectIdentity: workspaceObjectIdentity(rootStat),
      },
    ),
    root: lexicalRoot,
    signal,
  };
};

const pmWorkspaceFailure = (error: unknown) => {
  const record = asRecord(error);
  const candidate =
    typeof record?.code === 'string'
      ? record.code
      : typeof error === 'string'
        ? error
        : undefined;
  const code =
    candidate === 'qa_workspace_operation_cancelled'
      ? 'pm_workspace_operation_cancelled'
      : candidate === 'qa_workspace_path_rejected'
        ? 'pm_workspace_path_rejected'
        : candidate === 'invalid_input'
          ? candidate
          : 'pm_workspace_access_failed';
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

const pmWorkspaceSuccess = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
});

const createPmMcpServer = (
  configuration: PmRuntimeConfiguration,
  workspace: PmWorkspaceContext,
) =>
  createSdkMcpServer({
    name: 'mesh_pm',
    version: '1',
    alwaysLoad: true,
    tools: [
      tool(
        'read_workspace_file',
        'Read one bounded text file inside the assigned PM repository.',
        pmWorkspaceReadSchema.shape,
        async (input) => {
          const parsed = pmWorkspaceReadSchema.safeParse(input);
          if (!parsed.success) return pmWorkspaceFailure('invalid_input');
          try {
            return pmWorkspaceSuccess(
              await workspace.reader.read(workspace.root, parsed.data.path, {
                signal: workspace.signal,
              }),
            );
          } catch (error) {
            return pmWorkspaceFailure(error);
          }
        },
      ),
      tool(
        'glob_workspace_files',
        'Match bounded file paths inside the assigned PM repository.',
        pmWorkspaceGlobSchema.shape,
        async (input) => {
          const parsed = pmWorkspaceGlobSchema.safeParse(input);
          if (!parsed.success) return pmWorkspaceFailure('invalid_input');
          try {
            return pmWorkspaceSuccess(
              await workspace.reader.glob(
                workspace.root,
                parsed.data.path,
                parsed.data.pattern,
                { signal: workspace.signal },
              ),
            );
          } catch (error) {
            return pmWorkspaceFailure(error);
          }
        },
      ),
      tool(
        'search_workspace_text',
        'Search bounded text content inside the assigned PM repository.',
        pmWorkspaceSearchSchema.shape,
        async (input) => {
          const parsed = pmWorkspaceSearchSchema.safeParse(input);
          if (!parsed.success) return pmWorkspaceFailure('invalid_input');
          try {
            return pmWorkspaceSuccess(
              await workspace.reader.search(
                workspace.root,
                parsed.data.path,
                parsed.data.query,
                { signal: workspace.signal },
              ),
            );
          } catch (error) {
            return pmWorkspaceFailure(error);
          }
        },
      ),
      tool(
        'submit_project_plan',
        'Submit one complete structured project-plan proposal.',
        projectPlanProposalInputSchema.shape,
        async (input) => {
          const parsed = projectPlanProposalInputSchema.safeParse(input);
          if (!parsed.success)
            return pmControlFailure(
              'planning_proposal_invalid',
              parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.filter(
                  (entry): entry is string | number =>
                    typeof entry === 'string' || typeof entry === 'number',
                ),
                message: issue.message,
              })),
            );
          try {
            await configuration.submitProposal(parsed.data);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ status: 'submitted' }),
                },
              ],
            };
          } catch (error) {
            return pmControlFailure(error);
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
        model: message.model,
        claudeCodeVersion: message.claude_code_version,
        cwd: message.cwd,
        tools: message.tools,
        sourceEventId: message.uuid,
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

  if (message.type === 'tool_progress')
    return [
      {
        kind: 'activity',
        sourceEventId: message.uuid,
        activity: {
          kind: 'tool_progress',
          summary: `${message.tool_name} is running`,
          ...(validToolCallId(message.tool_use_id)
            ? { toolCallId: validToolCallId(message.tool_use_id) }
            : {}),
          elapsedSeconds: message.elapsed_time_seconds,
          details: message.subagent_retry
            ? { retry: message.subagent_retry }
            : undefined,
        },
      },
    ];

  if (message.type === 'system') {
    switch (message.subtype) {
      case 'status':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'status',
              summary: message.status ?? 'Claude status cleared',
              details: {
                ...(message.permissionMode
                  ? { permissionMode: message.permissionMode }
                  : {}),
                ...(message.compact_result
                  ? { compactResult: message.compact_result }
                  : {}),
                ...(message.compact_error
                  ? { compactError: message.compact_error }
                  : {}),
              },
            },
          },
        ];
      case 'api_retry':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'retry',
              summary: `API retry ${message.attempt} of ${message.max_retries}`,
              details: {
                retryDelayMs: message.retry_delay_ms,
                errorStatus: message.error_status,
                error: message.error,
              },
            },
          },
        ];
      case 'compact_boundary':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'compaction',
              summary: `Context compaction (${message.compact_metadata.trigger})`,
              details: {
                preTokens: message.compact_metadata.pre_tokens,
                ...(message.compact_metadata.post_tokens === undefined
                  ? {}
                  : { postTokens: message.compact_metadata.post_tokens }),
                ...(message.compact_metadata.duration_ms === undefined
                  ? {}
                  : { durationMs: message.compact_metadata.duration_ms }),
              },
            },
          },
        ];
      case 'hook_started':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'hook',
              summary: `${message.hook_name} started`,
              details: {
                hookId: message.hook_id,
                hookEvent: message.hook_event,
              },
            },
          },
        ];
      case 'hook_progress':
      case 'hook_response':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'hook',
              summary: `${message.hook_name} ${message.subtype === 'hook_progress' ? 'running' : message.outcome}`,
              details: {
                hookId: message.hook_id,
                hookEvent: message.hook_event,
                stdout: message.stdout,
                stderr: message.stderr,
                output: message.output,
                ...(message.subtype === 'hook_response' &&
                message.exit_code !== undefined
                  ? { exitCode: message.exit_code }
                  : {}),
              },
            },
          },
        ];
      case 'task_started':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'subagent',
              summary: message.description,
              ...(message.tool_use_id && validToolCallId(message.tool_use_id)
                ? { toolCallId: validToolCallId(message.tool_use_id) }
                : {}),
              details: {
                taskId: message.task_id,
                ...(message.subagent_type
                  ? { subagentType: message.subagent_type }
                  : {}),
                ...(message.task_type ? { taskType: message.task_type } : {}),
              },
            },
          },
        ];
      case 'task_progress':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'subagent',
              summary: message.summary ?? message.description,
              ...(message.tool_use_id && validToolCallId(message.tool_use_id)
                ? { toolCallId: validToolCallId(message.tool_use_id) }
                : {}),
              details: {
                taskId: message.task_id,
                usage: message.usage,
                ...(message.last_tool_name
                  ? { lastToolName: message.last_tool_name }
                  : {}),
              },
            },
          },
        ];
      case 'task_updated':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'subagent',
              summary: `Task ${message.task_id} updated`,
              details: { taskId: message.task_id, ...message.patch },
            },
          },
        ];
      case 'task_notification':
        return [
          {
            kind: 'activity',
            sourceEventId: message.uuid,
            activity: {
              kind: 'subagent',
              summary: message.summary,
              ...(message.tool_use_id && validToolCallId(message.tool_use_id)
                ? { toolCallId: validToolCallId(message.tool_use_id) }
                : {}),
              details: {
                taskId: message.task_id,
                status: message.status,
                ...(message.usage ? { usage: message.usage } : {}),
              },
            },
          },
        ];
      default:
        return [];
    }
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
    const perModel = Object.entries(message.modelUsage).map(
      ([model, usage]) => ({
        kind: 'usage' as const,
        sourceEventId: `${message.uuid}-${model}`,
        usage: {
          scope: 'query' as const,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          contextWindow: usage.contextWindow,
        },
      }),
    );
    const usage = message.usage;
    const reportedUsage = [
      {
        kind: 'usage' as const,
        sourceEventId: `${message.uuid}-turn`,
        usage: {
          scope: 'turn' as const,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(usage.cache_read_input_tokens === null
            ? {}
            : { cacheReadTokens: usage.cache_read_input_tokens }),
          ...(usage.cache_creation_input_tokens === null
            ? {}
            : { cacheCreationTokens: usage.cache_creation_input_tokens }),
          durationMs: message.duration_ms,
        },
      },
      ...perModel,
    ];
    if (message.subtype === 'success')
      return [...reportedUsage, { kind: 'completed' }];
    if (
      message.subtype === 'error_max_turns' ||
      message.subtype === 'error_max_budget_usd'
    ) {
      return [
        ...reportedUsage,
        {
          kind: 'limit',
          capability: message.subtype,
          message: message.errors.join('; ') || message.subtype,
        },
        { kind: 'completed' },
      ];
    }
    return [
      ...reportedUsage,
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
    private readonly revoke?: () => void,
  ) {}

  async *events(): AsyncIterable<SdkStreamEvent> {
    for await (const message of this.sdkQuery) yield* messageEvents(message);
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  accountInfo() {
    return this.sdkQuery.accountInfo();
  }

  async interrupt(): Promise<void> {
    if (typeof this.sdkQuery.interrupt !== 'function') {
      throw new UnsupportedSdkCapabilityError('interrupt');
    }
    this.revoke?.();
    await this.sdkQuery.interrupt();
  }

  close(): void {
    this.revoke?.();
    this.prompts.close();
    this.sdkQuery.close();
  }
}

const sameTools = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((toolName, index) => toolName === expected[index]);

export const createClaudeSdkFacade = (): SdkFacade => ({
  listSessions: async ({ cwd }) =>
    (await listSessions({ dir: cwd })).map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
    })),
  startQuery: (options: SdkQueryOptions) => {
    if (
      options.role?.role === 'pm' &&
      (!sameTools(options.role.availableTools, PM_BUILTIN_TOOLS) ||
        !sameTools(options.role.allowedTools, PM_AVAILABLE_TOOLS))
    ) {
      throw new Error('PM runtime tools do not match the read-only policy.');
    }
    const pmAbortController =
      options.role?.role === 'pm' ? new AbortController() : undefined;
    const pmWorkspace = pmAbortController
      ? pmWorkspaceContext(options.cwd, pmAbortController.signal)
      : undefined;
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
        includeHookEvents: true,
        permissionMode: 'default',
        ...(options.role
          ? {
              tools: [...options.role.availableTools],
              settingSources: [],
              strictMcpConfig: true,
              allowedTools: [...options.role.allowedTools],
              ...(options.role.role === 'qa'
                ? { disallowedTools: [...options.role.disallowedTools] }
                : options.role.role === 'pm'
                  ? { disallowedTools: [...PM_DISALLOWED_TOOLS] }
                  : {}),
            }
          : {}),
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
        ...(options.role?.role === 'qa'
          ? {
              mcpServers: {
                [options.role.controlServer.name]: createRoleMcpServer(
                  options.role.controlServer,
                ),
              },
            }
          : {}),
        ...(options.role?.role === 'pm' && pmWorkspace
          ? {
              mcpServers: {
                mesh_pm: createPmMcpServer(options.role, pmWorkspace),
              },
            }
          : {}),
      },
    });
    if (
      typeof sdkQuery.interrupt !== 'function' ||
      typeof sdkQuery.close !== 'function'
    ) {
      pmAbortController?.abort();
      sdkQuery.close?.();
      throw new UnsupportedSdkCapabilityError('streaming_control');
    }
    return new ClaudeSdkQuery(
      sessionId,
      sdkQuery,
      prompts,
      pmAbortController ? () => pmAbortController.abort() : undefined,
    );
  },
});
