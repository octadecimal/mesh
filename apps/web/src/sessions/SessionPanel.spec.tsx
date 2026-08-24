import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionEvent } from '@mesh-session-platform/contracts';

import { SessionPanel } from './SessionPanel';

const session = {
  id: 's1', projectId: 'p1', workspaceId: 'w1', title: 'Session A',
  permissionMode: 'interactive' as const, lifecycleState: 'running' as const,
  createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
};
const workspace = { id: 'w1', projectId: 'p1', type: 'worktree' as const, path: '/mesh', gitBranch: 'task-11' };
const events: SessionEvent[] = [
  { protocolVersion: 1, id: 'e1', sessionId: 's1', sequence: 1, occurredAt: '2026-08-24T00:00:00.000Z', type: 'message.assistant', payload: { text: 'Assistant reply' } },
  { protocolVersion: 1, id: 'e2', sessionId: 's1', sequence: 2, occurredAt: '2026-08-24T00:01:00.000Z', type: 'permission.requested', payload: { permissionId: 'permission-1', name: 'Bash', input: { command: 'git status' }, actions: ['approve', 'deny'] } },
];

describe('SessionPanel', () => {
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

    render(<SessionPanel session={session} workspace={workspace} events={events} api={api} auditAvailable />);

    expect(screen.getByText('Assistant reply')).toBeVisible();
    expect(diagnosticRequests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Raw diagnostics' }));
    expect(diagnosticRequests).toEqual(['s1']);
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(commands).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(commands.at(-1)).toMatchObject({ type: 'session.delete', payload: { sessionId: 's1', confirmed: true } });
  });
});
