import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewSessionDialog } from './NewSessionDialog';

describe('NewSessionDialog', () => {
  it('submits an isolated worktree with an explicit permission mode', async () => {
    const user = userEvent.setup();
    const commands: unknown[] = [];
    render(
      <NewSessionDialog
        open
        projects={[{ id: 'project-1', displayName: 'Mesh', repositoryPath: 'C:\\code\\mesh' }]}
        onCreate={(command) => commands.push(command)}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
    await user.selectOptions(screen.getByLabelText('Workspace type'), 'worktree');
    await user.type(screen.getByLabelText('Branch'), 'mesh/session-a');
    await user.type(screen.getByLabelText('Start point'), 'main');
    await user.type(screen.getByLabelText('Worktree path'), 'C:\\code\\worktrees\\session-a');
    await user.selectOptions(screen.getByLabelText('Permission mode'), 'interactive');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    expect(commands).toContainEqual(
      expect.objectContaining({
        type: 'session.create',
        payload: expect.objectContaining({
          projectId: 'project-1',
          permissionMode: 'interactive',
          workspace: {
            type: 'worktree',
            repositoryPath: 'C:\\code\\mesh',
            path: 'C:\\code\\worktrees\\session-a',
            branch: 'mesh/session-a',
            startPoint: 'main',
          },
        }),
      }),
    );
  });

  it('requires an absolute shared folder and surfaces a collision warning', async () => {
    const user = userEvent.setup();
    render(
      <NewSessionDialog
        open
        projects={[{ id: 'project-1', displayName: 'Mesh', repositoryPath: 'C:\\code\\mesh' }]}
        collisionWarning="This shared folder is already used by Session A."
        onCreate={() => undefined}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Project'), 'project-1');
    await user.selectOptions(screen.getByLabelText('Workspace type'), 'shared');
    await user.type(screen.getByLabelText('Shared folder path'), 'relative/path');
    await user.selectOptions(screen.getByLabelText('Permission mode'), 'safe_auto');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    expect(screen.getByText('Enter an absolute folder path.')).toBeDefined();
    expect(screen.getByText('This shared folder is already used by Session A.')).toBeDefined();
  });
});
