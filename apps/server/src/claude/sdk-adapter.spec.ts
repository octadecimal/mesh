import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  type DeveloperBlockerReport,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReport,
  type DeveloperCompletionReportInput,
} from '@mesh-session-platform/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
};

type QueryInput = {
  options: {
    includePartialMessages?: boolean;
    mcpServers?: Record<string, unknown>;
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
