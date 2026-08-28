import { describe, expect, it } from 'vitest';

import {
  SdkClaudeSessionDriver,
  UnsupportedSdkCapabilityError,
  UnsafeClaudeCredentialError,
  type SdkAccountInfo,
  type SdkFacade,
  type SdkPermissionRequest,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkStreamEvent,
} from './sdk-driver.js';
import { selectClaudeDriver } from '../main.js';
import {
  PM_AVAILABLE_TOOLS,
  PM_BUILTIN_TOOLS,
} from '../domain/planning-policy.js';
import type { PmRuntimeConfiguration } from './driver.js';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
};

class ScriptedQuery implements SdkQuery {
  readonly prompts: string[] = [];
  interrupted = false;
  closed = false;

  constructor(
    private readonly scriptedEvents: readonly SdkStreamEvent[],
    private readonly account: SdkAccountInfo = {
      apiKeySource: 'none',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
      tokenSource: 'oauth',
    },
  ) {}

  async *events(): AsyncIterable<SdkStreamEvent> {
    yield* this.scriptedEvents;
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async accountInfo(): Promise<SdkAccountInfo> {
    return this.account;
  }

  close(): void {
    this.closed = true;
  }
}

class ScriptedFacade implements SdkFacade {
  readonly queryCalls: SdkQueryOptions[] = [];
  readonly query: ScriptedQuery;

  constructor(events: readonly SdkStreamEvent[], account?: SdkAccountInfo) {
    this.query = new ScriptedQuery(events, account);
  }

  async listSessions(): Promise<Array<{ sessionId: string; title?: string }>> {
    return [{ sessionId: 'resume-discovered', title: 'Discovered' }];
  }

  startQuery(options: SdkQueryOptions): SdkQuery {
    this.queryCalls.push(options);
    return this.query;
  }

  requestPermission(request: SdkPermissionRequest) {
    return this.queryCalls[0]?.onPermission?.(request);
  }
}

describe('SdkClaudeSessionDriver contract', () => {
  it.each(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key'])(
    'fails closed when SDK initialization reports the API-billed %s source',
    async (apiKeySource) => {
      const sdk = new ScriptedFacade(
        [{ kind: 'started', sessionId: 'unsafe', apiKeySource }],
        {
          apiKeySource,
          apiProvider: 'firstParty',
          subscriptionType: 'max',
          tokenSource: 'oauth',
        },
      );

      await expect(
        new SdkClaudeSessionDriver(sdk).create({ title: 'Session' }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<UnsafeClaudeCredentialError>>({
          code: 'billing_configuration_conflict',
          apiKeySource,
        }),
      );
      expect(sdk.query.closed).toBe(true);
      expect(sdk.query.prompts).toEqual([]);
    },
  );

  it('fails closed when account metadata does not positively establish a first-party subscription', async () => {
    const sdk = new ScriptedFacade(
      [{ kind: 'started', sessionId: 'ambiguous', apiKeySource: 'none' }],
      { apiKeySource: 'none', apiProvider: 'gateway' },
    );

    await expect(
      new SdkClaudeSessionDriver(sdk).create({ title: 'Session' }),
    ).rejects.toMatchObject({ code: 'billing_configuration_conflict' });
    expect(sdk.query.closed).toBe(true);
  });

  it('keeps consuming events after a completed turn', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-multi', apiKeySource: 'none' },
      { kind: 'assistant_text', text: 'first turn' },
      { kind: 'completed' },
      { kind: 'assistant_text', text: 'second turn' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
      permissionMode: 'interactive',
    });

    await expect(collect(session.events())).resolves.toEqual([
      { kind: 'text_completed', text: 'first turn' },
      { kind: 'text_completed', text: 'second turn' },
    ]);
  });

  it('maps SDK identity, assistant/tool streaming, and completion into driver-owned events', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-1', apiKeySource: 'none' },
      { kind: 'assistant_text', text: 'hello' },
      {
        kind: 'tool_requested',
        toolCallId: 'tool-1',
        name: 'Read',
        input: { path: 'a.ts' },
      },
      {
        kind: 'tool_completed',
        toolCallId: 'tool-1',
        output: 'ok',
        isError: false,
      },
      { kind: 'completed' },
    ]);

    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
      workspacePath: 'C:\\repo',
      permissionMode: 'interactive',
    });

    expect(session.claudeResumeId).toBe('resume-1');
    expect(await collect(session.events())).toEqual([
      { kind: 'text_completed', text: 'hello' },
      {
        kind: 'tool_requested',
        toolCallId: 'tool-1',
        name: 'Read',
        input: { path: 'a.ts' },
      },
      {
        kind: 'tool_completed',
        toolCallId: 'tool-1',
        output: 'ok',
        isError: false,
      },
    ]);
  });

  it('uses resume identity, forwards prompts and interruption, and exposes discovery', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-2', apiKeySource: 'none' },
      { kind: 'completed' },
    ]);
    const driver = new SdkClaudeSessionDriver(sdk);

    expect(await driver.discover({ workspacePath: 'C:\\repo' })).toEqual([
      { claudeResumeId: 'resume-discovered', title: 'Discovered' },
    ]);
    const session = await driver.resume({
      claudeResumeId: 'resume-2',
      workspacePath: 'C:\\repo',
      permissionMode: 'interactive',
    });
    await session.sendPrompt('continue');
    await session.interrupt();
    await session.close();

    expect(sdk.queryCalls[0]).toMatchObject({
      cwd: 'C:\\repo',
      resume: 'resume-2',
    });
    expect(sdk.query.prompts).toEqual(['continue']);
    expect(sdk.query.interrupted).toBe(true);
    expect(sdk.query.closed).toBe(true);
  });

  it('forwards Developer runtime configuration for create and resume queries', async () => {
    const controls = {
      submitForReview: async () => undefined,
      markBlocked: async () => undefined,
    };
    const developer = { initialPrompt: 'Execute the assigned task.', controls };
    const createSdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-create', apiKeySource: 'none' },
    ]);
    const resumeSdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-existing', apiKeySource: 'none' },
    ]);

    await new SdkClaudeSessionDriver(createSdk).create({
      title: 'Developer',
      developer,
    });
    await new SdkClaudeSessionDriver(resumeSdk).resume({
      claudeResumeId: 'resume-existing',
      developer,
    });

    expect(createSdk.queryCalls[0]?.developer).toBe(developer);
    expect(resumeSdk.queryCalls[0]?.developer).toBe(developer);
    expect(createSdk.query.prompts).toEqual(['Execute the assigned task.']);
    expect(resumeSdk.query.prompts).toEqual(['Execute the assigned task.']);
  });

  it('forwards an isolated QA role with the exact workspace and only verification controls', async () => {
    const qa = {
      role: 'qa' as const,
      initialPrompt: 'Verify the assigned Developer submission.',
      availableTools: [] as string[],
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
            execute: async () => ({
              content: [{ type: 'text' as const, text: '{"status":"ok"}' }],
            }),
          },
        ],
      },
    };
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-qa', apiKeySource: 'none' },
    ]);

    await new SdkClaudeSessionDriver(sdk).create({
      title: 'QA',
      workspacePath: 'C:\\repo\\developer-workspace',
      permissionMode: 'inherit',
      role: qa,
    });

    expect(sdk.queryCalls[0]).toMatchObject({
      cwd: 'C:\\repo\\developer-workspace',
      role: qa,
    });
    expect(sdk.queryCalls[0]?.developer).toBeUndefined();
    expect(sdk.queryCalls[0]).not.toHaveProperty('onPermission');
    expect(qa.availableTools).toEqual([]);
    expect(qa.disallowedTools).toContain('Bash');
    expect(sdk.query.prompts).toEqual([
      'Verify the assigned Developer submission.',
    ]);
    expect(qa.controlServer.tools.map(({ name }) => name)).toEqual([
      'submit_qa_verdict',
    ]);
    expect(qa.allowedTools).not.toEqual(
      expect.arrayContaining([
        'Write',
        'Edit',
        'submit_for_review',
        'mark_blocked',
      ]),
    );
  });

  it('forwards the dedicated read-only PM runtime for create and resume', async () => {
    const pm: PmRuntimeConfiguration = {
      role: 'pm',
      initialPrompt: 'Plan the approved project goal.',
      availableTools: PM_BUILTIN_TOOLS,
      allowedTools: PM_AVAILABLE_TOOLS,
      submitProposal: async () => undefined,
    };
    const createSdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-pm-create', apiKeySource: 'none' },
    ]);
    const resumeSdk = new ScriptedFacade([
      {
        kind: 'started',
        sessionId: 'resume-pm-existing',
        apiKeySource: 'none',
      },
    ]);

    await new SdkClaudeSessionDriver(createSdk).create({
      title: 'PM',
      workspacePath: 'C:\\repo',
      permissionMode: 'inherit',
      role: pm,
    });
    await new SdkClaudeSessionDriver(resumeSdk).resume({
      claudeResumeId: 'resume-pm-existing',
      workspacePath: 'C:\\repo',
      permissionMode: 'inherit',
      role: pm,
    });

    expect(createSdk.queryCalls[0]).toMatchObject({
      cwd: 'C:\\repo',
      role: pm,
    });
    expect(resumeSdk.queryCalls[0]).toMatchObject({
      cwd: 'C:\\repo',
      resume: 'resume-pm-existing',
      role: pm,
    });
    expect(createSdk.queryCalls[0]?.developer).toBeUndefined();
    expect(createSdk.queryCalls[0]).not.toHaveProperty('onPermission');
    expect(createSdk.query.prompts).toEqual([
      'Plan the approved project goal.',
    ]);
    expect(resumeSdk.query.prompts).toEqual([
      'Plan the approved project goal.',
    ]);
    expect(pm.availableTools).toEqual([]);
    expect(pm.allowedTools).toEqual([
      'mcp__mesh_pm__read_workspace_file',
      'mcp__mesh_pm__glob_workspace_files',
      'mcp__mesh_pm__search_workspace_text',
      'mcp__mesh_pm__submit_project_plan',
    ]);
    expect(pm.availableTools).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Task',
        'submit_for_review',
        'mark_blocked',
        'submit_qa_verdict',
      ]),
    );
  });

  it('diagnoses mixed Developer and role-specific QA or PM authority', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-mixed', apiKeySource: 'none' },
    ]);

    await expect(
      new SdkClaudeSessionDriver(sdk).create({
        title: 'Mixed',
        developer: {
          initialPrompt: 'Develop.',
          controls: {
            submitForReview: async () => undefined,
            markBlocked: async () => undefined,
          },
        },
        role: {
          role: 'qa',
          initialPrompt: 'Verify.',
          availableTools: [],
          allowedTools: ['mcp__mesh_qa__submit_qa_verdict'],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit'],
          controlServer: { name: 'mesh_qa', version: '1', tools: [] },
        },
      }),
    ).rejects.toThrow(
      'cannot combine Developer runtime controls with role-specific QA or PM runtime controls',
    );
    expect(sdk.queryCalls).toEqual([]);
  });

  it('blocks an interactive permission callback until the driver resolves it', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-3', apiKeySource: 'none' },
      { kind: 'completed' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
      permissionMode: 'interactive',
    });
    const permission = sdk.requestPermission({
      requestId: 'request-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      input: { path: 'a.ts' },
    });
    const iterator = session.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: 'permission_requested',
        permissionId: 'request-1',
        toolCallId: 'tool-1',
        name: 'Write',
        input: { path: 'a.ts' },
      },
    });
    await session.resolvePermission('request-1', 'approve');
    await expect(permission).resolves.toBe('approve');
  });

  it('omits the permission callback for inherit mode and lets the SDK stream complete', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-inherit', apiKeySource: 'none' },
      { kind: 'completed' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
      permissionMode: 'inherit',
    });

    expect(sdk.queryCalls[0]).not.toHaveProperty('onPermission');
    await expect(collect(session.events())).resolves.toEqual([]);
  });

  it('keeps safe-auto permission decisions on the injected callback', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-safe-auto', apiKeySource: 'none' },
      { kind: 'completed' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
      permissionMode: 'safe_auto',
    });

    expect(sdk.queryCalls[0]?.onPermission).toBeTypeOf('function');
    await expect(
      sdk.requestPermission({
        requestId: 'request-safe',
        toolUseId: 'tool-safe',
        toolName: 'Read',
        input: { path: 'safe.ts' },
      }),
    ).resolves.toBe('approve');
    await expect(collect(session.events())).resolves.toEqual([]);
  });

  it('maps subscription limits and execution failures without throwing SDK values', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-4', apiKeySource: 'none' },
      {
        kind: 'limit',
        capability: 'seven_day',
        message: 'Usage limit reached',
      },
      {
        kind: 'error',
        code: 'error_during_execution',
        message: 'Claude failed',
        details: ['failure'],
      },
      { kind: 'completed' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({
      title: 'Session',
    });

    expect(await collect(session.events())).toEqual([
      {
        kind: 'limit',
        capability: 'seven_day',
        message: 'Usage limit reached',
      },
      {
        kind: 'terminal_error',
        code: 'error_during_execution',
        message: 'Claude failed',
        details: ['failure'],
      },
    ]);
  });

  it('fails with a typed capability error when the SDK stream has no session identity', async () => {
    const sdk = new ScriptedFacade([{ kind: 'completed' }]);

    await expect(
      new SdkClaudeSessionDriver(sdk).create({ title: 'Session' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<UnsupportedSdkCapabilityError>>({
        code: 'unsupported_claude_capability',
        capability: 'session_identity',
      }),
    );
  });

  it('does not construct the SDK driver when a billing conflict blocks startup', async () => {
    let constructions = 0;
    const driver = selectClaudeDriver(
      [{ variable: 'ANTHROPIC_API_KEY' }],
      () => {
        constructions += 1;
        return new SdkClaudeSessionDriver(new ScriptedFacade([]));
      },
    );

    expect(constructions).toBe(0);
    expect(await driver.discover({})).toEqual([]);
    await expect(driver.create({ title: 'blocked' })).rejects.toMatchObject({
      code: 'billing_configuration_conflict',
    });
  });
});
