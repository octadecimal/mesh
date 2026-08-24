import { describe, expect, it } from 'vitest';

import {
  SdkClaudeSessionDriver,
  UnsupportedSdkCapabilityError,
  type SdkFacade,
  type SdkPermissionRequest,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkStreamEvent,
} from './sdk-driver.js';
import { selectClaudeDriver } from '../main.js';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
};

class ScriptedQuery implements SdkQuery {
  readonly prompts: string[] = [];
  interrupted = false;
  closed = false;

  constructor(private readonly scriptedEvents: readonly SdkStreamEvent[]) {}

  async *events(): AsyncIterable<SdkStreamEvent> {
    yield* this.scriptedEvents;
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  close(): void {
    this.closed = true;
  }
}

class ScriptedFacade implements SdkFacade {
  readonly queryCalls: SdkQueryOptions[] = [];
  readonly query: ScriptedQuery;

  constructor(events: readonly SdkStreamEvent[]) {
    this.query = new ScriptedQuery(events);
  }

  async listSessions(): Promise<Array<{ sessionId: string; title?: string }>> {
    return [{ sessionId: 'resume-discovered', title: 'Discovered' }];
  }

  startQuery(options: SdkQueryOptions): SdkQuery {
    this.queryCalls.push(options);
    return this.query;
  }

  requestPermission(request: SdkPermissionRequest) {
    return this.queryCalls[0]?.onPermission(request);
  }
}

describe('SdkClaudeSessionDriver contract', () => {
  it('maps SDK identity, assistant/tool streaming, and completion into driver-owned events', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-1', apiKeySource: 'none' },
      { kind: 'assistant_text', text: 'hello' },
      { kind: 'tool_requested', toolCallId: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
      { kind: 'tool_completed', toolCallId: 'tool-1', output: 'ok', isError: false },
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
      { kind: 'tool_requested', toolCallId: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
      { kind: 'tool_completed', toolCallId: 'tool-1', output: 'ok', isError: false },
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

    expect(sdk.queryCalls[0]).toMatchObject({ cwd: 'C:\\repo', resume: 'resume-2' });
    expect(sdk.query.prompts).toEqual(['continue']);
    expect(sdk.query.interrupted).toBe(true);
    expect(sdk.query.closed).toBe(true);
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

  it('maps subscription limits and execution failures without throwing SDK values', async () => {
    const sdk = new ScriptedFacade([
      { kind: 'started', sessionId: 'resume-4', apiKeySource: 'none' },
      { kind: 'limit', capability: 'seven_day', message: 'Usage limit reached' },
      { kind: 'error', code: 'error_during_execution', message: 'Claude failed', details: ['failure'] },
      { kind: 'completed' },
    ]);
    const session = await new SdkClaudeSessionDriver(sdk).create({ title: 'Session' });

    expect(await collect(session.events())).toEqual([
      { kind: 'limit', capability: 'seven_day', message: 'Usage limit reached' },
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

    await expect(new SdkClaudeSessionDriver(sdk).create({ title: 'Session' })).rejects.toEqual(
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
