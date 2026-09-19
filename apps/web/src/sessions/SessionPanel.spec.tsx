import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useHookstate } from '@hookstate/core';
import type { SessionEvent } from '@mesh-session-platform/contracts';
import { afterEach, vi } from 'vitest';

import { SessionPanel } from './SessionPanel';
import { createMeshStore } from '../state/store';

const session = {
  id: 's1',
  projectId: 'p1',
  workspaceId: 'w1',
  title: 'Session A',
  permissionMode: 'interactive' as const,
  lifecycleState: 'running' as const,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};
const workspace = {
  id: 'w1',
  projectId: 'p1',
  type: 'worktree' as const,
  path: '/mesh',
  gitBranch: 'task-11',
};
const events: SessionEvent[] = [
  {
    protocolVersion: 1,
    id: 'e1',
    sessionId: 's1',
    sequence: 1,
    occurredAt: '2026-08-24T00:00:00.000Z',
    type: 'message.assistant',
    payload: { text: 'Assistant reply' },
  },
  {
    protocolVersion: 1,
    id: 'e2',
    sessionId: 's1',
    sequence: 2,
    occurredAt: '2026-08-24T00:01:00.000Z',
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      name: 'Bash',
      input: { command: 'git status' },
      actions: ['approve', 'deny'],
    },
  },
];

describe('SessionPanel', () => {
  afterEach(() => vi.useRealTimers());
  it('defaults to a verbose timestamped timeline and remembers compact mode', async () => {
    const user = userEvent.setup();
    localStorage.removeItem('mesh.verboseTimeline');
    const view = render(
      <SessionPanel session={session} workspace={workspace} events={events} />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Verbose timeline' }),
    ).toBeChecked();
    expect(screen.getAllByText(/^\d{2}:\d{2}:\d{2}$/).length).toBeGreaterThan(
      0,
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Verbose timeline' }),
    );
    expect(localStorage.getItem('mesh.verboseTimeline')).toBe('false');

    view.unmount();
    render(
      <SessionPanel session={session} workspace={workspace} events={events} />,
    );
    expect(
      screen.getByRole('checkbox', { name: 'Verbose timeline' }),
    ).not.toBeChecked();
    expect(screen.getByText('Assistant reply')).toBeVisible();
    localStorage.removeItem('mesh.verboseTimeline');
  });

  it('renders normalized content, lazily loads diagnostics, and confirms deletion', async () => {
    const user = userEvent.setup();
    const diagnosticRequests: string[] = [];
    const commands: unknown[] = [];
    const api = {
      diagnostics: async (sessionId: string) => {
        diagnosticRequests.push(sessionId);
        return { protocolVersion: 1 as const, sessionId, diagnostics: [] };
      },
      command: async (command: unknown) => {
        commands.push(command);
        return { protocolVersion: 1 as const, commandType: 'ok', result: {} };
      },
    };

    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={api}
        auditAvailable
      />,
    );

    expect(screen.getByText('Assistant reply')).toBeVisible();
    expect(diagnosticRequests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Raw diagnostics' }));
    expect(diagnosticRequests).toEqual(['s1']);
    await user.click(screen.getByText('Session actions'));
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(commands).toHaveLength(0);
    await user.click(
      screen.getByRole('button', { name: 'Delete permanently' }),
    );
    expect(commands.at(-1)).toMatchObject({
      type: 'session.delete',
      payload: { sessionId: 's1', confirmed: true },
    });
  });

  it('keeps the conversation focused until details are requested', async () => {
    const user = userEvent.setup();
    const api = {
      diagnostics: async (sessionId: string) => ({
        protocolVersion: 1 as const,
        sessionId,
        diagnostics: [],
      }),
      command: async () => ({
        protocolVersion: 1 as const,
        commandType: 'ok',
        result: {},
      }),
    };
    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={api}
        auditAvailable
      />,
    );

    expect(screen.getByLabelText('Permission Bash')).toBeVisible();
    expect(screen.queryByLabelText('Session details')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Interrupt session' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Delete session' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByLabelText('Session details')).toHaveTextContent('/mesh');
    await user.click(screen.getByText('Session actions'));
    expect(
      screen.getByRole('button', { name: 'Delete session' }),
    ).toBeVisible();
  });

  it('keeps deletion confirmation open when the command fails', async () => {
    const user = userEvent.setup();
    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={{
          diagnostics: async (sessionId) => ({
            protocolVersion: 1 as const,
            sessionId,
            diagnostics: [],
          }),
          command: async () => {
            throw new Error('Delete failed');
          },
        }}
      />,
    );

    await user.click(screen.getByText('Session actions'));
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    await user.click(
      screen.getByRole('button', { name: 'Delete permanently' }),
    );
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed');
  });

  it('isolates deletion confirmation and restores the actions trigger focus', async () => {
    const user = userEvent.setup();
    render(<SessionPanel session={session} events={events} auditAvailable />);

    await user.click(screen.getByText('Session actions'));
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Archive session' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete session' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(screen.getByText('Session actions')).toHaveFocus();
    expect(
      screen.getByRole('button', { name: 'Archive session' }),
    ).toBeVisible();
  });

  it('keeps an interrupt failure visible beside the composer', async () => {
    const user = userEvent.setup();
    render(
      <SessionPanel
        session={session}
        events={events}
        api={{
          diagnostics: async (sessionId) => ({
            protocolVersion: 1 as const,
            sessionId,
            diagnostics: [],
          }),
          command: async () => {
            throw new Error('Interrupt failed');
          },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Interrupt failed');
  });

  it('keeps interrupt available while waiting for a permission decision', () => {
    render(
      <SessionPanel
        session={{ ...session, lifecycleState: 'waiting_for_approval' }}
        events={events}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Interrupt session' }),
    ).toBeVisible();
  });

  it('renders accumulated streaming text as one temporary assistant card', () => {
    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        streamingAssistantText="Response in progress"
      />,
    );

    expect(
      screen.getByLabelText('Streaming assistant message'),
    ).toHaveTextContent('Response in progress');
    expect(screen.getAllByText('Response in progress')).toHaveLength(1);
  });

  it('keeps a prompt-started elapsed clock while streamed text receipts update activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:05.000Z'));
    render(
      <SessionPanel
        session={session}
        connectionHealth="connected"
        lastLiveActivityAt="2026-08-24T00:00:05.000Z"
        streamingAssistantText="still receiving"
        events={[
          {
            protocolVersion: 1,
            id: 'prompt-1',
            sessionId: 's1',
            sequence: 1,
            occurredAt: '2026-08-24T00:00:00.000Z',
            type: 'message.user',
            payload: { text: 'work' },
          },
          usageEvent('init-model', 2, { model: 'claude-opus' }),
        ]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Receiving Claude response',
    );
    expect(screen.getByRole('status')).toHaveTextContent('5s elapsed');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Last activity just now',
    );
    expect(screen.queryByText('Ready for prompt')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status')).toHaveTextContent('7s elapsed');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Last activity 2s ago',
    );
  });

  it('keeps completed and failed state over stale transport status', () => {
    const view = render(
      <SessionPanel
        session={{ ...session, lifecycleState: 'completed' }}
        events={events}
        connectionHealth="connected"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Session completed');
    view.rerender(
      <SessionPanel
        session={{ ...session, lifecycleState: 'failed' }}
        events={events}
        connectionHealth="disconnected"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Connection unavailable',
    );
    expect(screen.queryByText('Waiting for response')).not.toBeInTheDocument();
  });

  it('keeps normalized event details closed until requested and pairs tool events', async () => {
    const user = userEvent.setup();
    const paired = [
      toolRequested('e3', 'call-a', 'Read', { path: 'a.ts' }),
      toolCompleted('e4', 'call-a', { content: 'done' }, false),
      {
        protocolVersion: 1 as const,
        id: 'e5',
        sessionId: 's1',
        sequence: 5,
        occurredAt: '2026-08-24T00:00:00.000Z',
        type: 'message.assistant' as const,
        payload: { text: 'done' },
      },
    ];
    render(<SessionPanel session={session} events={paired} />);

    const tool = screen.getByLabelText('Tool call Read');
    const toolDetails = tool.querySelector('details');
    expect(toolDetails).not.toHaveAttribute('open');
    await user.click(toolDetails?.querySelector('summary') as HTMLElement);
    expect(tool).toHaveTextContent('tool.requested');
    expect(tool).toHaveTextContent('tool.completed');
    const assistant = screen.getByLabelText('Assistant message');
    await user.click(assistant.querySelector('summary') as HTMLElement);
    expect(assistant).toHaveTextContent('message.assistant');
    expect(assistant).toHaveTextContent('e5');
  });

  it('loads diagnostics one cursor page at a time only after opening and appends the next page', async () => {
    const user = userEvent.setup();
    const requests: Array<[string, unknown]> = [];
    const firstPage = Array.from({ length: 10 }, (_, index) =>
      diagnostic(`d${index + 1}`),
    );
    const api = {
      diagnostics: async (sessionId: string, options?: unknown) => {
        requests.push([sessionId, options]);
        return requests.length === 1
          ? {
              protocolVersion: 1 as const,
              sessionId,
              diagnostics: firstPage,
              nextAfter: 'd10',
            }
          : {
              protocolVersion: 1 as const,
              sessionId,
              diagnostics: [diagnostic('d11')],
            };
      },
      command: async () => ({
        protocolVersion: 1 as const,
        commandType: 'ok',
        result: {},
      }),
    };
    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={api}
        auditAvailable
      />,
    );

    expect(requests).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Raw diagnostics' }));
    await waitFor(() => expect(requests).toEqual([['s1', { limit: 10 }]]));
    await user.click(
      screen.getByRole('button', { name: 'Load more diagnostics' }),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        ['s1', { limit: 10 }],
        ['s1', { after: 'd10', limit: 10 }],
      ]),
    );
    expect(screen.getByLabelText('Diagnostic d11')).toBeVisible();
  });

  it('keeps a Hookstate prompt draft when the panel remounts and gates sending when audit is unavailable', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot());
    const api = {
      diagnostics: async () => ({
        protocolVersion: 1 as const,
        sessionId: 's1',
        diagnostics: [],
      }),
      command: async () => ({
        protocolVersion: 1 as const,
        commandType: 'ok',
        result: {},
      }),
    };
    function Harness() {
      const projection = useHookstate(store.state).get({ noproxy: true });
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <button onClick={() => setMounted((value) => !value)}>
            Toggle panel
          </button>
          {mounted ? (
            <SessionPanel
              session={session}
              workspace={workspace}
              events={events}
              api={api}
              auditAvailable
              promptDraft={projection.promptDrafts.s1 ?? ''}
              onPromptDraftChange={(value) => store.setPromptDraft('s1', value)}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    await user.type(
      screen.getByRole('textbox', { name: 'Prompt' }),
      'persist me',
    );
    await user.click(screen.getByRole('button', { name: 'Toggle panel' }));
    await user.click(screen.getByRole('button', { name: 'Toggle panel' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(
      'persist me',
    );

    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={api}
        auditAvailable={false}
        promptDraft="send this"
        onPromptDraftChange={() => undefined}
      />,
    );
    expect(
      screen.getAllByRole('button', { name: 'Send prompt' }).at(-1),
    ).toBeDisabled();
  });

  it('renders reported activity and per-turn usage without inventing metrics', () => {
    render(
      <SessionPanel
        session={session}
        events={[
          {
            protocolVersion: 1,
            id: 'e-activity',
            sessionId: 's1',
            sequence: 1,
            occurredAt: '2026-08-24T00:00:00.000Z',
            type: 'session.activity',
            payload: {
              kind: 'tool_progress',
              summary: 'Searching source',
              toolCallId: 'call-a',
              elapsedSeconds: 2,
              details: { path: 'apps/web' },
            },
          },
          {
            protocolVersion: 1,
            id: 'e-usage',
            sessionId: 's1',
            sequence: 2,
            occurredAt: '2026-08-24T00:00:02.000Z',
            type: 'session.usage',
            payload: { model: 'Claude Sonnet', inputTokens: 123 },
          },
        ]}
        connectionHealth="connected"
      />,
    );

    expect(screen.getByText('Searching source')).toBeVisible();
    expect(screen.getByText('Claude Sonnet · input 123')).toBeVisible();
    expect(screen.queryByText(/context used/i)).not.toBeInTheDocument();
  });

  it('stops claiming a live response after terminal or disconnected state', () => {
    const view = render(
      <SessionPanel
        session={{ ...session, lifecycleState: 'completed' }}
        events={events}
        streamingAssistantText="stale text"
        connectionHealth="connected"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Session completed');
    expect(
      screen.queryByLabelText('Streaming assistant message'),
    ).not.toBeInTheDocument();

    view.rerender(
      <SessionPanel
        session={session}
        events={events}
        streamingAssistantText="stale text"
        connectionHealth="disconnected"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Connection unavailable',
    );
    expect(
      screen.queryByLabelText('Streaming assistant message'),
    ).not.toBeInTheDocument();
  });

  it('prioritizes approval and a newer prompt over old usage, and labels pending tools honestly', () => {
    const pending = toolRequested('e3', 'call-a', 'Read', { path: 'a.ts' });
    const view = render(
      <SessionPanel
        session={{ ...session, lifecycleState: 'waiting_for_approval' }}
        events={[pending, events[1]]}
        connectionHealth="connected"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for approval',
    );

    view.rerender(
      <SessionPanel
        session={session}
        events={[pending]}
        connectionHealth="disconnected"
      />,
    );
    expect(screen.getByLabelText('Tool request Read')).toHaveTextContent(
      'Last known running',
    );

    view.rerender(
      <SessionPanel
        session={session}
        connectionHealth="connected"
        events={[
          {
            protocolVersion: 1,
            id: 'e-usage-turn',
            sessionId: 's1',
            sequence: 1,
            occurredAt: '2026-08-24T00:00:00.000Z',
            type: 'session.usage',
            payload: { scope: 'turn', durationMs: 100 },
          },
          {
            protocolVersion: 1,
            id: 'e-new-prompt',
            sessionId: 's1',
            sequence: 2,
            occurredAt: '2026-08-24T00:00:01.000Z',
            type: 'message.user',
            payload: { text: 'again' },
          },
        ]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for response',
    );
  });

  it('keeps the latest usage for each scope and model without merging records', () => {
    render(
      <SessionPanel
        session={session}
        connectionHealth="connected"
        events={[
          usageEvent('u1', 1, { scope: 'query', model: 'A', inputTokens: 1 }),
          usageEvent('u2', 2, { scope: 'query', model: 'A', inputTokens: 2 }),
          usageEvent('u3', 3, {
            scope: 'query',
            model: 'B',
            cacheReadTokens: 3,
          }),
          usageEvent('u4', 4, { scope: 'turn', model: 'A', outputTokens: 4 }),
        ]}
      />,
    );
    expect(screen.queryByText('A · input 1')).not.toBeInTheDocument();
    expect(screen.getByText('A · input 2')).toBeVisible();
    expect(screen.getByText('B · cache read 3')).toBeVisible();
    expect(screen.getByText('A · output 4')).toBeVisible();
  });

  it('renders undefined tool output safely and keeps error output in compact mode', async () => {
    const user = userEvent.setup();
    render(
      <SessionPanel
        session={session}
        events={[toolCompleted('e9', 'orphan', undefined, true)]}
      />,
    );
    expect(screen.getByText('No output reported')).toBeVisible();
    await user.click(
      screen.getByRole('checkbox', { name: 'Verbose timeline' }),
    );
    expect(screen.getByText('No output reported')).toBeVisible();
  });

  it('pairs interleaved tool results with their matching requests and shows policy mode while deciding permissions', async () => {
    const user = userEvent.setup();
    let resolveCommand: (() => void) | undefined;
    const api = {
      diagnostics: async () => ({
        protocolVersion: 1 as const,
        sessionId: 's1',
        diagnostics: [],
      }),
      command: async () =>
        new Promise((resolve) => {
          resolveCommand = () =>
            resolve({
              protocolVersion: 1 as const,
              commandType: 'ok',
              result: {},
            });
        }),
    };
    const interleaved: SessionEvent[] = [
      toolRequested('e3', 'call-a', 'Read', { path: 'a.ts' }),
      toolRequested('e4', 'call-b', 'Bash', { command: 'git status' }),
      toolCompleted('e5', 'call-b', { stdout: 'clean' }, false),
      toolCompleted('e6', 'call-a', { message: 'missing' }, true),
      events[1],
    ];
    render(
      <SessionPanel
        session={session}
        workspace={workspace}
        events={interleaved}
        api={api}
        auditAvailable
      />,
    );

    const bash = screen.getByLabelText('Tool call Bash');
    expect(bash).toHaveTextContent('git status');
    expect(bash).toHaveTextContent('clean');
    const read = screen.getByLabelText('Tool call Read');
    expect(read).toHaveTextContent('a.ts');
    expect(read).toHaveTextContent('missing');
    expect(screen.getByText('Policy mode: interactive')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    resolveCommand?.();
  });
});

const diagnostic = (id: string) => ({
  id,
  sessionId: 's1',
  capturedAt: '2026-08-24T00:00:00.000Z',
  payload: { id },
});
const toolRequested = (
  id: string,
  toolCallId: string,
  name: string,
  input: unknown,
): SessionEvent => ({
  protocolVersion: 1,
  id,
  sessionId: 's1',
  sequence: Number(id.slice(1)),
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'tool.requested',
  payload: { toolCallId, name, input },
});
const toolCompleted = (
  id: string,
  toolCallId: string,
  output: unknown,
  isError: boolean,
): SessionEvent => ({
  protocolVersion: 1,
  id,
  sessionId: 's1',
  sequence: Number(id.slice(1)),
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'tool.completed',
  payload: { toolCallId, output, isError },
});
const usageEvent = (
  id: string,
  sequence: number,
  payload: Extract<SessionEvent, { type: 'session.usage' }>['payload'],
): SessionEvent => ({
  protocolVersion: 1,
  id,
  sessionId: 's1',
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'session.usage',
  payload,
});
const snapshot = () => ({
  protocolVersion: 1 as const,
  projects: [],
  workspaces: [],
  sessions: [session],
  events: [],
  pendingApprovals: [],
  lastSequenceBySession: {},
  layouts: [],
});
