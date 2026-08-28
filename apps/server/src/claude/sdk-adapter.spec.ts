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

const { createSdkMcpServer, query, tool } = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((options: unknown) => ({
    type: 'sdk',
    name: 'mesh_developer',
    options,
  })),
  query: vi.fn((options: QueryInput) => {
    void options;
    return {
      async *[Symbol.asyncIterator]() {
        yield* [];
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
import { PM_AVAILABLE_TOOLS } from '../domain/planning-policy.js';

describe('createClaudeSdkFacade', () => {
  beforeEach(() => {
    createSdkMcpServer.mockClear();
    query.mockClear();
    tool.mockClear();
  });

  it('requests partial SDK messages for live assistant text', () => {
    createClaudeSdkFacade().startQuery({
      title: 'Streaming',
      cwd: 'C:/code/mesh',
    });

    expect(query.mock.calls[0]?.[0].options.includePartialMessages).toBe(true);
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
        availableTools: PM_AVAILABLE_TOOLS,
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
      'submit_project_plan',
    ]);
    expect(query.mock.calls.at(-1)?.[0].options).toMatchObject({
      tools: ['Read', 'Glob', 'Grep', 'mcp__mesh_pm__submit_project_plan'],
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'mcp__mesh_pm__submit_project_plan',
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
    expect(options.allowedTools).toEqual(options.tools);

    const result = await serverOptions.tools[0]?.handler(proposal);
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
          availableTools: PM_AVAILABLE_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      }),
    ).toThrow('PM runtime requires an explicit repository working directory');
    expect(query).not.toHaveBeenCalled();
  });

  it('confines every PM repository read to the canonical cwd before tool execution', async () => {
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
          availableTools: PM_AVAILABLE_TOOLS,
          allowedTools: PM_AVAILABLE_TOOLS,
          submitProposal: async () => undefined,
        },
      });
      const options = query.mock.calls.at(-1)?.[0].options;
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      expect(options.hooks?.PreToolUse?.[0]?.matcher).toBe('Read|Glob|Grep');
      expect(hook).toBeTypeOf('function');

      const invoke = async (tool_name: string, tool_input: unknown) =>
        hook?.({ hook_event_name: 'PreToolUse', tool_name, tool_input });
      const allowed = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'defer',
        },
      };
      const denied = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'PM repository reads are confined to the session working directory.',
        },
      };

      await expect(invoke('Read', { file_path: insideFile })).resolves.toEqual(
        allowed,
      );
      await expect(invoke('Glob', { pattern: '**/*.ts' })).resolves.toEqual(
        allowed,
      );
      await expect(
        invoke('Glob', { pattern: '**/*.ts', path: 'src' }),
      ).resolves.toEqual(allowed);
      await expect(invoke('Grep', { pattern: 'inside' })).resolves.toEqual(
        allowed,
      );
      await expect(
        invoke('Grep', { pattern: 'inside', path: 'src' }),
      ).resolves.toEqual(allowed);

      for (const [toolName, input] of [
        ['Read', { path: insideFile }],
        ['Read', { file_path: 42 }],
        ['Read', { file_path: outsideFile }],
        ['Read', { file_path: join('..', 'outside', 'secret.txt') }],
        ['Read', { file_path: join(repository, 'escape', 'secret.txt') }],
        ['Glob', { pattern: '**/*', path: outside }],
        ['Glob', { pattern: '../outside/**/*' }],
        ['Glob', { pattern: '**/*', path: join('..', 'outside') }],
        ['Glob', { pattern: '**/*', path: join(repository, 'escape') }],
        ['Glob', { pattern: '**/*', path: 42 }],
        ['Grep', { pattern: 'secret', path: outside }],
        ['Grep', { pattern: 'secret', path: join('..', 'outside') }],
        ['Grep', { pattern: 'secret', path: join(repository, 'escape') }],
        ['Grep', { pattern: 'secret', path: null }],
      ] as const) {
        await expect(invoke(toolName, input)).resolves.toEqual(denied);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects PM tool configuration that expands or reorders the fixed policy', () => {
    expect(() =>
      createClaudeSdkFacade().startQuery({
        role: {
          role: 'pm',
          initialPrompt: 'Plan.',
          availableTools: [...PM_AVAILABLE_TOOLS, 'Bash'],
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
        availableTools: PM_AVAILABLE_TOOLS,
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
