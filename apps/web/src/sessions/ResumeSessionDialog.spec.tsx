import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResumeSessionDialog } from './ResumeSessionDialog';

describe('ResumeSessionDialog', () => {
  it('shows discovered Claude identity and resumes only the selected application session', async () => {
    const user = userEvent.setup();
    const commands: unknown[] = [];
    render(
      <ResumeSessionDialog
        open
        sessions={[
          {
            id: 'session-1',
            title: 'Investigate worktree',
            claudeResumeId: 'claude-session-1',
            lastPath: 'C:\\code\\mesh',
            applicationMatch: 'Matched Mesh session',
            permissionMode: 'interactive',
            workspaceType: 'worktree',
          },
        ]}
        onResume={(command) => commands.push(command)}
      />,
    );

    expect(screen.getByText('claude-session-1')).toBeDefined();
    expect(screen.getByText('C:\\code\\mesh')).toBeDefined();
    expect(screen.getByText('Matched Mesh session')).toBeDefined();
    expect(screen.queryByText(/still running|last prompt/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resume session' }));

    expect(commands).toContainEqual({
      type: 'session.resume',
      payload: { sessionId: 'session-1' },
    });
  });

  it('renders typed resume failures as actionable messages', () => {
    render(
      <ResumeSessionDialog
        open
        sessions={[]}
        onResume={() => undefined}
        error={{
          code: 'worktree_dirty',
          message: 'Commit, stash, or choose another worktree before resuming.',
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Commit, stash, or choose another worktree before resuming.',
    );
  });
});
