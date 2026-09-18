import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { ProjectCreateDialog } from './ProjectCreateDialog';

const project = {
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\code\\projects\\mesh',
};

describe('ProjectCreateDialog', () => {
  it('keeps the selected parent directory when the picker is cancelled', async () => {
    const user = userEvent.setup();
    const onBrowse = vi.fn().mockResolvedValue(null);
    render(<ProjectCreateDialog open onBrowse={onBrowse} onCreate={vi.fn()} />);

    await user.type(
      screen.getByLabelText('Parent directory'),
      'C:\\code\\projects',
    );
    await user.click(
      screen.getByRole('button', { name: 'Browse for parent folder' }),
    );

    expect(onBrowse).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Parent directory')).toHaveValue(
      'C:\\code\\projects',
    );
  });

  it('creates one project from its name and parent directory', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(project);
    render(<ProjectCreateDialog open onCreate={onCreate} />);

    await user.type(screen.getByLabelText('Project name'), 'mesh');
    await user.type(
      screen.getByLabelText('Parent directory'),
      'C:\\code\\projects',
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: 'mesh',
        parentDirectory: 'C:\\code\\projects',
      }),
    );
  });
});
