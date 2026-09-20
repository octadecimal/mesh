import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  projectPlanProposalInputSchema,
  type DeveloperBlockerReport,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReport,
  type DeveloperCompletionReportInput,
} from '@mesh-session-platform/contracts';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
};

type QueryInput = {
  options: {
    cwd?: string;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    includePartialMessages?: boolean;
    includeHookEvents?: boolean;
    mcpServers?: Record<string, unknown>;
    settingSources?: string[];
    strictMcpConfig?: boolean;
    hooks?: {
      PreToolUse?: Array<{
        matcher?: string;
        hooks: Array<
          (input: {
            hook_event_name: string;
            tool_name: string;
            tool_input: unknown;
          }) => Promise<unknown>
        >;
      }>;
    };
  };
};

const { createSdkMcpServer, emittedMessages, query, tool } = vi.hoisted(() => ({
  emittedMessages: [] as unknown[],
  createSdkMcpServer: vi.fn((options: unknown) => ({
    type: 'sdk',
    name: 'mesh_developer',
    options,
  })),
  query: vi.fn((options: QueryInput) => {
    void options;
    return {
      async *[Symbol.asyncIterator]() {
        yield* emittedMessages;
      },
      interrupt: async () => undefined,
      close: () => undefined,
    };
  }),
  tool: vi.fn(
    (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: (input: unknown) => Promise<unknown>,
    ): ToolDefinition => ({ name, description, inputSchema, handler }),
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer,
  listSessions: vi.fn(async () => []),
  query,
  tool,
}));

import { createClaudeSdkFacade } from './sdk-adapter.js';
import {
  PM_AVAILABLE_TOOLS,
  PM_BUILTIN_TOOLS,
} from '../domain/planning-policy.js';

describe('createClaudeSdkFacade', () => {
  beforeEach(() => {
    createSdkMcpServer.mockClear();
    query.mockClear();
    tool.mockClear();
    emittedMessages.splice(0);
  });

  it('requests partial SDK messages for live assistant text', () => {
    createClaudeSdkFacade().startQuery({
      title: 'Streaming',
      cwd: 'C:/code/mesh',
    });

    expect(query.mock.calls[0]?.[0].options.includePartialMessages).toBe(true);
    expect(query.mock.calls[0]?.[0].options.includeHookEvents).toBe(true);
  });

  it('maps recognized SDK activity and reported per-model usage', async () => {
    emittedMessages.push(
      {
        type: 'system',
        subtype: 'init',
        uuid: 'init-1',
        session_id: 'sdk-1',
        apiKeySource: 'none',
        model: 'claude-opus',
        claude_code_version: '1.0',
        cwd: 'C:/repo',
        tools: ['Read'],
        mcp_servers: [],
        slash_commands: [],
        permissionMode: 'default',
        output_style: 'default',
        skills: [],
        plugins: [],
      },
      {
        type: 'tool_progress',
        uuid: 'progress-1',
        session_id: 'sdk-1',
        tool_use_id: 'tool-1',
        tool_name: 'Read',
        parent_tool_use_id: null,
        elapsed_time_seconds: 2,
      },
      {
        type: 'system',
        subtype: 'hook_progress',
        uuid: 'hook-1',
        session_id: 'sdk-1',
        hook_id: 'hook-a',
        hook_name: 'format',
        hook_event: 'PostToolUse',
        stdout: 'formatted',
        stderr: '',
        output: 'ok',
      },
      {
        type: 'system',
        subtype: 'api_retry',
        uuid: 'retry-1',
        session_id: 'sdk-1',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 100,
        error_status: 529,
        error: 'overloaded',
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
        session_id: 'sdk-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 100,
          post_tokens: 20,
          duration_ms: 4,
        },
      },
      {
        type: 'system',
        subtype: 'task_progress',
        uuid: 'task-1',
        session_id: 'sdk-1',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Inspect code',
        usage: { total_tokens: 9, tool_uses: 1, duration_ms: 3 },
        last_tool_name: 'Read',
        summary: 'Reading',
      },
      {
        type: 'result',
        subtype: 'success',
        uuid: 'result-1',
        session_id: 'sdk-1',
        duration_ms: 20,
        duration_api_ms: 10,
        is_error: false,
        num_turns: 1,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {
          'claude-opus': {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
        permission_denials: [],
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        uuid: 'result-2',
        session_id: 'sdk-1',
        duration_ms: 21,
        duration_api_ms: 11,
        is_error: true,
        num_turns: 2,
        stop_reason: null,
        total_cost_usd: 0,
        errors: ['turn cap'],
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {
          'claude-sonnet': {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 100000,
            maxOutputTokens: 8192,
          },
        },
        permission_denials: [],
      },
    );
    const stream = createClaudeSdkFacade().startQuery({ title: 'Streaming' });
    const events = [] as unknown[];
    for await (const event of stream.events()) events.push(event);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'started', model: 'claude-opus' }),
        expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({
            kind: 'tool_progress',
            elapsedSeconds: 2,
          }),
        }),
        expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({
            kind: 'hook',
            details: expect.objectContaining({ stdout: 'formatted' }),
          }),
        }),
        expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({ kind: 'retry' }),
        }),
        expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({ kind: 'compaction' }),
        }),
        expect.objectContaining({
          kind: 'activity',
          activity: expect.objectContaining({
            kind: 'subagent',
            summary: 'Reading',
          }),
        }),
        expect.objectContaining({
          kind: 'usage',
          usage: expect.objectContaining({
            model: 'claude-opus',
            contextWindow: 200000,
            scope: 'query',
          }),
        }),
        expect.objectContaining({
          kind: 'usage',
          usage: expect.objectContaining({
            model: 'claude-sonnet',
            contextWindow: 100000,
            scope: 'query',
          }),
        }),
        expect.objectContaining({
          kind: 'limit',
          capability: 'error_max_turns',
        }),
      ]),
    );
  });

  it('keeps turn usage separate from cumulative per-model query usage', async () => {
    const result = (
      uuid: string,
      inputTokens: number,
      modelUsage: Record<string, unknown>,
    ) => ({
      type: 'result',
      subtype: 'success',
      uuid,
      session_id: 'sdk-1',
      duration_ms: 25,
      duration_api_ms: 10,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage,
      permission_denials: [],
    });
    const model = (inputTokens: number) => ({
      inputTokens,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    });
    emittedMessages.push(
      {
        type: 'system',
        subtype: 'init',
        uuid: 'init-1',
        session_id: 'sdk-1',
        apiKeySource: 'none',
        model: 'claude-opus',
        claude_code_version: '1.0',
        cwd: 'C:/repo',
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        permissionMode: 'default',
        output_style: 'default',
        skills: [],
        plugins: [],
      },
      result('turn-1', 10, { 'claude-opus': model(10) }),
      result('turn-2', 10, {
        'claude-opus': model(20),
        'claude-sonnet': model(5),
      }),
    );
    const events: Array<{
      kind?: string;
      sourceEventId?: string;
      usage?: Record<string, unknown>;
    }> = [];
    for await (const event of createClaudeSdkFacade()
      .startQuery({ title: 'Usage' })
      .events())
      events.push(event);

    expect(events.filter(({ usage }) => usage?.scope === 'turn')).toEqual([
      expect.objectContaining({
        sourceEventId: 'turn-1-turn',
        usage: expect.objectContaining({
          scope: 'turn',
          inputTokens: 10,
          outputTokens: 2,
          durationMs: 25,
        }),
      }),
      expect.objectContaining({
        sourceEventId: 'turn-2-turn',
        usage: expect.objectContaining({
          scope: 'turn',
          inputTokens: 10,
          outputTokens: 2,
          durationMs: 25,
        }),
      }),
    ]);
    expect(events.filter(({ usage }) => usage?.scope === 'query')).toEqual([
      expect.objectContaining({
        sourceEventId: 'turn-1-claude-opus',
        usage: expect.objectContaining({
          model: 'claude-opus',
          inputTokens: 10,
          contextWindow: 200000,
        }),
      }),
      expect.objectContaining({
        sourceEventId: 'turn-2-claude-opus',
        usage: expect.objectContaining({
          model: 'claude-opus',
          inputTokens: 20,
          contextWindow: 200000,
        }),
      }),
      expect.objectContaining({
        sourceEventId: 'turn-2-claude-sonnet',
        usage: expect.objectContaining({
          model: 'claude-sonnet',
          inputTokens: 5,
          contextWindow: 200000,
        }),
      }),
    ]);
    expect(
      events
        .filter(({ usage }) => usage?.scope === 'query')
        .every(({ usage }) => usage?.durationMs === undefined),
    ).toBe(true);
    expect(events.find(({ kind }) => kind === 'started')).toMatchObject({
      model: 'claude-opus',
    });
  });

  it('does not install Mesh MCP tools for ordinary sessions', () => {
    createClaudeSdkFacade().startQuery({ title: 'Ordinary' });

    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty('mcpServers');
    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty('hooks');
    expect(createSdkMcpServer).not.toHaveBeenCalled();
  });

  it('installs exactly the always-loaded Mesh Developer control tools', () => {
    const controls = {
      submitForReview: vi.fn(async () => undefined),
      markBlocked: vi.fn(async () => undefined),
    };

    createClaudeSdkFacade().startQuery({
      title: 'Developer',
      developer: { initialPrompt: 'Execute this task.', controls },
    });

    const serverOptions = createSdkMcpServer.mock.calls[0]?.[0] as {
      name: string;
      version: string;
      alwaysLoad: boolean;
      tools: ToolDefinition[];
    };
    expect(serverOptions).toMatchObject({
      name: 'mesh_developer',
      version: '1',
      alwaysLoad: true,
    });
    expect(serverOptions.tools.map(({ name }) => name)).toEqual([
      'submit_for_review',
      'mark_blocked',
    ]);
    expect(
      Object.keys(query.mock.calls[0]?.[0].options.mcpServers ?? {}),
    ).toEqual(['mesh_developer']);
    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty('tools');
    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty(
      'settingSources',
    );
    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty(
      'strictMcpConfig',
    );
    expect(query.mock.calls[0]?.[0].options).not.toHaveProperty('hooks');
  });

  it('installs one generic QA control server without Developer or source-authoring tools', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"status":"submitted"}' }],
    }));

    createClaudeSdkFacade().startQuery({
      title: 'QA',
      role: {
        role: 'qa',
        initialPrompt: 'Verify the submission.',
        availableTools: [],
        allowedTools: ['mcp__mesh_qa__submit_qa_verdict'],
        disallowedTools: [
          'Bash',
          'Read',
          'Glob',
          'Grep',
          'Write',
          'Edit',
          'NotebookEdit',
        ],
        controlServer: {
          name: 'mesh_qa',
          version: '1',
          tools: [
            {
              name: 'submit_qa_verdict',
              description: 'Submit one structured QA verdict.',
              inputSchema: {},
              execute,
            },
          ],
        },
      },
    });

    const serverOptions = createSdkMcpServer.mock.calls.at(-1)?.[0] as {
      name: string;
      version: string;
      alwaysLoad: boolean;
      tools: ToolDefinition[];
    };
    expect(serverOptions).toMatchObject({
      name: 'mesh_qa',
      version: '1',
      alwaysLoad: true,
    });
    expect(serverOptions.tools.map(({ name }) => name)).toEqual([
      'submit_qa_verdict',
    ]);
    expect(query.mock.calls.at(-1)?.[0].options).toMatchObject({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: ['mcp__mesh_qa__submit_qa_verdict'],
      disallowedTools: [
        'Bash',
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'NotebookEdit',
      ],
    });
    expect(
      Object.keys(query.mock.calls.at(-1)?.[0].options.mcpServers ?? {}),
    ).toEqual(['mesh_qa']);
    expect(query.mock.calls.at(-1)?.[0].options).not.toHaveProperty('hooks');

    await serverOptions.tools[0]?.handler({ disposition: 'verified' });
    expect(execute).toHaveBeenCalledWith({ disposition: 'verified' });
  });

  it('installs only the read-only PM tools and delivers one structured proposal callback', async () => {
    const proposal = projectPlanProposalInputSchema.parse({
      tasks: [],
      dependencies: [],
      assumptions: ['The current board is authoritative.'],
      risks: [],
      exclusions: [],
    });
    const submitProposal = vi.fn(async () => undefined);

    createClaudeSdkFacade().startQuery({
      title: 'PM',
      cwd: process.cwd(),
      role: {
        role: 'pm',
        initialPrompt: 'Plan the approved project goal.',
        availableTools: PM_BUILTIN_TOOLS,
        allowedTools: PM_AVAILABLE_TOOLS,
        submitProposal,
      },
    });

    const serverOptions = createSdkMcpServer.mock.calls.at(-1)?.[0] as {
      name: string;
      version: string;
      alwaysLoad: boolean;
      tools: ToolDefinition[];
    };
    expect(serverOptions).toMatchObject({
      name: 'mesh_pm',
      version: '1',
      alwaysLoad: true,
    });
    expect(serverOptions.tools.map(({ name }) => name)).toEqual([
      'read_workspace_file',
      'glob_workspace_files',
      'search_workspace_text',
      'submit_project_plan',
    ]);
    expect(query.mock.calls.at(-1)?.[0].options).toMatchObject({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: [
        'mcp__mesh_pm__read_workspace_file',
        'mcp__mesh_pm__glob_workspace_files',
        'mcp__mesh_pm__search_workspace_text',
        'mcp__mesh_pm__submit_project_plan',
      ],
      disallowedTools: [
        'Bash',
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'NotebookEdit',
      ],
    });
    const options = query.mock.calls.at(-1)?.[0].options;
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['mesh_pm']);
    expect(options.tools).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Task',
        'mcp__mesh_developer__submit_for_review',
        'mcp__mesh_developer__mark_blocked',
        'mcp__mesh_qa__submit_qa_verdict',
      ]),
    );
    expect(options).not.toHaveProperty('hooks');

    const result = await pmTools().submit_project_plan?.handler(proposal);
    expect(submitProposal).toHaveBeenCalledOnce();
    expect(submitProposal).toHaveBeenCalledWith(proposal);
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"status":"submitted"}' }],
    });
  });

  it('requires an explicit repository cwd for the PM runtime boundary', () => {
    expect(() =>
      createClaudeSdkFacade().startQuery({
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: PM_BUILTIN_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      }),
    ).toThrow('PM runtime requires an explicit repository working directory');
    expect(query).not.toHaveBeenCalled();
  });

  it('confines Mesh-owned PM reads, globs, and searches to the canonical cwd', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'mesh-pm-read-boundary-'));
    const repository = join(fixture, 'repository');
    const source = join(repository, 'src');
    const outside = join(fixture, 'outside');
    mkdirSync(source, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const insideFile = join(source, 'inside.ts');
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(insideFile, 'export const inside = true;');
    writeFileSync(outsideFile, 'secret');
    symlinkSync(
      outside,
      join(repository, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      createClaudeSdkFacade().startQuery({
        cwd: repository,
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: PM_BUILTIN_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      });
      const options = query.mock.calls.at(-1)?.[0].options;
      expect(options).not.toHaveProperty('hooks');
      const tools = pmTools();

      await expect(
        tools.read_workspace_file?.handler({ path: 'src/inside.ts' }),
      ).resolves.toMatchObject({
        content: [{ text: expect.stringContaining('inside = true') }],
      });
      const globResult = (await tools.glob_workspace_files?.handler({
        pattern: '**/*.ts',
      })) as { content: Array<{ type: 'text'; text: string }> } | undefined;
      expect(JSON.parse(globResult?.content[0]?.text ?? '{}')).toMatchObject({
        files: [join('src', 'inside.ts')],
      });
      await expect(
        tools.search_workspace_text?.handler({ path: 'src', query: 'inside' }),
      ).resolves.toMatchObject({
        content: [{ text: expect.stringContaining('inside = true') }],
      });

      for (const [toolName, input] of [
        ['read_workspace_file', { path: outsideFile }],
        ['read_workspace_file', { path: join('..', 'outside', 'secret.txt') }],
        ['read_workspace_file', { path: join('escape', 'secret.txt') }],
        ['glob_workspace_files', { pattern: '../outside/**/*' }],
        ['glob_workspace_files', { pattern: '**/*', path: outside }],
        ['glob_workspace_files', { pattern: '**/*', path: 'escape' }],
        ['search_workspace_text', { query: 'secret', path: outside }],
        ['search_workspace_text', { query: 'secret', path: '../outside' }],
        ['search_workspace_text', { query: 'secret', path: 'escape' }],
      ] as const) {
        await expect(tools[toolName]?.handler(input)).resolves.toMatchObject({
          isError: true,
        });
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects path-affecting Glob expansions while preserving simple in-root patterns', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'mesh-pm-glob-boundary-'));
    try {
      createClaudeSdkFacade().startQuery({
        cwd: repository,
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: PM_BUILTIN_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      });
      const glob = pmTools().glob_workspace_files;
      const invoke = async (pattern: string) => glob?.handler({ pattern });

      for (const pattern of [
        '**/*.ts',
        'src/**/*.{ts,tsx}',
        'src/{feature-one,feature_two}/**/*.ts',
      ]) {
        await expect(invoke(pattern)).resolves.not.toMatchObject({
          isError: true,
        });
      }

      for (const pattern of [
        '{../outside,src}/**/*',
        '{/etc,src}/**/*',
        '{C:/Windows,src}/**/*',
        '{C,D}:/Windows/**/*',
        '{.,safe}./outside/**/*',
        '{src,{../outside,safe}}/**/*',
        'src/{nested/path,flat}/**/*',
        '[.][.]/outside/**/*',
        '\\.\\./outside/**/*',
        'safe/\\.\\./\\.\\./outside/**/*',
        '@(../outside|src)/**/*',
        '!(C:/Windows|src)/**/*',
        '+(/etc|src)/**/*',
        'src/{ts,tsx',
        'src/ts,tsx}/**/*',
        'src/{ts,,tsx}/**/*',
      ]) {
        await expect(invoke(pattern)).resolves.toMatchObject({ isError: true });
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('revokes PM workspace controls when the owning SDK query is interrupted', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'mesh-pm-read-revoked-'));
    try {
      writeFileSync(join(repository, 'readme.md'), '# Planning');
      const sdkQuery = createClaudeSdkFacade().startQuery({
        cwd: repository,
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: PM_BUILTIN_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      });
      const read = pmTools().read_workspace_file;

      await sdkQuery.interrupt();

      const result = await read?.handler({ path: 'readme.md' });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(
        'pm_workspace_operation_cancelled',
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects PM tool configuration that expands or reorders the fixed policy', () => {
    expect(() =>
      createClaudeSdkFacade().startQuery({
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: [...PM_BUILTIN_TOOLS, 'Bash'],
          allowedTools: [...PM_AVAILABLE_TOOLS].reverse(),
          submitProposal: async () => undefined,
        },
      }),
    ).toThrow('PM runtime tools do not match the read-only policy');
    expect(query).not.toHaveBeenCalled();
    expect(createSdkMcpServer).not.toHaveBeenCalled();
  });

  it('returns sanitized structured PM errors and does not invoke the callback for invalid payloads', async () => {
    const secret = 'planning-capability-secret';
    const error = Object.assign(new Error(`expired ${secret}`), {
      code: 'planning_capability_expired',
    });
    const submitProposal = vi.fn(async () => {
      throw error;
    });
    createClaudeSdkFacade().startQuery({
      cwd: process.cwd(),
      role: {
        role: 'pm',
        initialPrompt: 'Plan.',
        availableTools: PM_BUILTIN_TOOLS,
        allowedTools: PM_AVAILABLE_TOOLS,
        submitProposal,
      },
    });
    const pmTool = pmTools().submit_project_plan;

    const invalid = (await pmTool?.handler({})) as
      | { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
      | undefined;
    expect(invalid).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('"code":"planning_proposal_invalid"'),
        },
      ],
      isError: true,
    });
    expect(JSON.parse(invalid?.content[0]?.text ?? '{}')).toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ path: ['tasks'] }),
      ]),
    });
    expect(submitProposal).not.toHaveBeenCalled();

    const failed = await pmTool?.handler({
      tasks: [],
      dependencies: [],
      assumptions: [],
      risks: [],
      exclusions: [],
    });
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed)).toContain('planning_capability_expired');
    expect(JSON.stringify(failed)).not.toContain(secret);
  });

  it('invokes Developer controls from model-visible evidence and an idempotency key', async () => {
    const capability = 'secret-capability-value';
    const {
      id: _completionId,
      cycleId: _completionCycle,
      createdAt: _completionAt,
      ...completion
    } = completionReport();
    const {
      id: _blockerId,
      cycleId: _blockerCycle,
      createdAt: _blockerAt,
      ...blocker
    } = blockerReport();
    const completionInput = { idempotencyKey: 'submit-1', ...completion };
    const blockerInput = { idempotencyKey: 'blocked-1', ...blocker };
    const controls = {
      submitForReview: vi.fn(async (report: DeveloperCompletionReportInput) => {
        void report;
        void capability;
      }),
      markBlocked: vi.fn(async (report: DeveloperBlockerReportInput) => {
        void report;
        void capability;
      }),
    };
    createClaudeSdkFacade().startQuery({
      developer: { initialPrompt: 'Execute.', controls },
    });
    const tools = developerTools();

    const submitResult =
      await tools.submit_for_review?.handler(completionInput);
    const blockResult = await tools.mark_blocked?.handler(blockerInput);

    expect(controls.submitForReview).toHaveBeenCalledOnce();
    expect(controls.submitForReview).toHaveBeenCalledWith(completionInput);
    expect(controls.markBlocked).toHaveBeenCalledOnce();
    expect(controls.markBlocked).toHaveBeenCalledWith(blockerInput);
    expect(submitResult).toMatchObject({
      content: [{ type: 'text', text: '{"status":"submitted_for_review"}' }],
    });
    expect(blockResult).toMatchObject({
      content: [{ type: 'text', text: '{"status":"blocked"}' }],
    });
    expect(JSON.stringify(tools)).not.toContain('capability');
    expect(JSON.stringify(tools)).not.toContain('cycleId');
    expect(JSON.stringify(tools)).not.toContain('createdAt');
    expect(JSON.stringify([submitResult, blockResult])).not.toContain(
      capability,
    );
  });

  it('returns MCP errors for invalid input and typed callback failures without leaking closure data', async () => {
    const capability = 'secret-capability-value';
    const controls = {
      submitForReview: vi.fn(async () => undefined),
      markBlocked: vi.fn(async () => {
        const error = new Error(`expired ${capability}`) as Error & {
          code: string;
        };
        error.code = 'developer_capability_invalid';
        throw error;
      }),
    };
    createClaudeSdkFacade().startQuery({
      developer: { initialPrompt: 'Execute.', controls },
    });
    const tools = developerTools();

    const invalidCompletion = await tools.submit_for_review?.handler({});
    const invalidBlocker = await tools.mark_blocked?.handler({});
    const failed = await tools.mark_blocked?.handler(blockerInput());

    expect(invalidCompletion).toMatchObject({ isError: true });
    expect(invalidBlocker).toMatchObject({ isError: true });
    expect(controls.submitForReview).not.toHaveBeenCalled();
    expect(controls.markBlocked).toHaveBeenCalledOnce();
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed)).toContain('developer_capability_invalid');
    expect(JSON.stringify(failed)).not.toContain(capability);
  });

  it('sanitizes a capability-like callback error code before returning MCP content', async () => {
    const capability = 'capability_secret_Bs3Qp7wK9x';
    const controls = {
      submitForReview: vi.fn(async () => undefined),
      markBlocked: vi.fn(async () => {
        const error = new Error('Developer control failed') as Error & {
          code: string;
        };
        error.code = capability;
        throw error;
      }),
    };
    createClaudeSdkFacade().startQuery({
      developer: { initialPrompt: 'Execute.', controls },
    });

    const failed = await developerTools().mark_blocked?.handler(blockerInput());

    expect(failed).toEqual({
      content: [
        {
          type: 'text',
          text: '{"status":"error","code":"developer_control_failed"}',
        },
      ],
      isError: true,
    });
    expect(JSON.stringify(failed)).not.toContain(capability);
  });
});

const developerTools = (): Record<string, ToolDefinition> => {
  const serverOptions = createSdkMcpServer.mock.calls.at(-1)?.[0] as {
    tools: ToolDefinition[];
  };
  return Object.fromEntries(
    serverOptions.tools.map((entry) => [entry.name, entry]),
  );
};

const pmTools = (): Record<string, ToolDefinition> => {
  const serverOptions = createSdkMcpServer.mock.calls.at(-1)?.[0] as {
    tools: ToolDefinition[];
  };
  return Object.fromEntries(
    serverOptions.tools.map((entry) => [entry.name, entry]),
  );
};

const completionReport = (): DeveloperCompletionReport =>
  developerCompletionReportSchema.parse({
    id: 'report-complete',
    cycleId: 'cycle-1',
    summary: 'Implemented the task.',
    criterionResults: [
      { criterionId: 'criterion-1', status: 'met', evidence: 'Focused test.' },
    ],
    verification: [{ command: 'pnpm test', outcome: 'passed', output: 'pass' }],
    limitations: '',
    workspaceState: {
      summary: 'One focused change.',
      hasUncommittedChanges: false,
      commitsCreated: true,
    },
    reviewerNotes: null,
    createdAt: '2026-08-25T12:00:00.000Z',
  });

const blockerReport = (): DeveloperBlockerReport =>
  developerBlockerReportSchema.parse({
    id: 'report-blocked',
    cycleId: 'cycle-1',
    reason: 'Human input required.',
    evidence: 'The required choice is absent.',
    attemptedWork: 'Inspected the available configuration.',
    suggestedHumanAction: 'Choose the target.',
    preserveWorkspace: true,
    createdAt: '2026-08-25T12:00:00.000Z',
  });

const blockerInput = () => {
  const { id, cycleId, createdAt, ...report } = blockerReport();
  void id;
  void cycleId;
  void createdAt;
  return { idempotencyKey: 'blocked-command', ...report };
};
