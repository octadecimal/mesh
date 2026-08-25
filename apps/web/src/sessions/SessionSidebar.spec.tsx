import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionSidebar } from './SessionSidebar';

describe('SessionSidebar', () => {
  it('groups sessions by project and filters them by title', async () => {
    const user = userEvent.setup();
    render(
      <SessionSidebar
        projects={[
          { id: 'p1', displayName: 'Mesh' },
          { id: 'p2', displayName: 'Other' },
        ]}
        workspaces={[
          { id: 'w1', projectId: 'p1', type: 'shared' },
          { id: 'w2', projectId: 'p2', type: 'worktree' },
        ]}
        sessions={[
          {
            id: 's1',
            projectId: 'p1',
            workspaceId: 'w1',
            title: 'Alpha',
            lifecycleState: 'running',
          },
          {
            id: 's2',
            projectId: 'p2',
            workspaceId: 'w2',
            title: 'Bravo',
            lifecycleState: 'waiting_for_approval',
          },
        ]}
        onOpenSession={() => undefined}
        onNewSession={() => undefined}
      />,
    );

    expect(screen.getAllByText('Mesh')).not.toHaveLength(0);
    expect(screen.getByText('Other')).toBeDefined();
    await user.type(
      screen.getByRole('searchbox', { name: 'Filter sessions' }),
      'bravo',
    );
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Bravo')).toBeDefined();
    expect(screen.getByText('worktree')).toBeDefined();
    expect(screen.getByLabelText('Approval required')).toBeDefined();
  });
});
