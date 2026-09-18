import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { ProjectImportDialog } from './ProjectImportDialog';

const suggestions = [
  {
    displayName: 'Suggested repository',
    repositoryPath: 'C:\\code\\suggested',
  },
];

describe('ProjectImportDialog', () => {
  it('keeps discovery suggestions non-mutating until an explicit import', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn().mockResolvedValue(project);
    render(
      <ProjectImportDialog
        open
        suggestions={suggestions}
        onImport={onImport}
      />,
    );

    expect(screen.getByText('Suggested repositories')).toBeDefined();
    expect(screen.getByText('Suggested repository')).toBeDefined();
    expect(
      screen.getByText(/Suggestions are not imported projects/i),
    ).toBeDefined();
    expect(onImport).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'Use Suggested repository' }),
    );
    expect(screen.getByLabelText('Repository path')).toHaveValue(
      'C:\\code\\suggested',
    );
    expect(onImport).not.toHaveBeenCalled();
  });

  it('imports a manually entered absolute repository path', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn().mockResolvedValue(project);
    render(<ProjectImportDialog open suggestions={[]} onImport={onImport} />);

    await user.type(screen.getByLabelText('Repository path'), 'C:\\code\\mesh');
    await user.click(screen.getByRole('button', { name: 'Import project' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        repositoryPath: 'C:\\code\\mesh',
        displayName: undefined,
      }),
    );
  });

  it('keeps manual import available when discovery fails', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn().mockResolvedValue(project);
    render(
      <ProjectImportDialog
        open
        suggestions={[]}
        discoveryError="Repository discovery is unavailable."
        onImport={onImport}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Repository discovery is unavailable.',
    );
    expect(
      screen.getByText(
        'Choose a repository with Browse or enter its absolute path.',
      ),
    ).toBeDefined();
    await user.type(
      screen.getByLabelText('Repository path'),
      'C:\\\\code\\\\mesh',
    );
    await user.click(screen.getByRole('button', { name: 'Import project' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
  });

  it('preserves a manual path when browsing is cancelled or fails', async () => {
    const user = userEvent.setup();
    const onBrowse = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Picker unavailable'));
    render(
      <ProjectImportDialog
        open
        suggestions={[]}
        onBrowse={onBrowse}
        onImport={vi.fn()}
      />,
    );

    const path = screen.getByLabelText('Repository path');
    await user.type(path, 'C:\\code\\mesh');
    await user.click(
      screen.getByRole('button', { name: 'Browse repository folder' }),
    );
    expect(path).toHaveValue('C:\\code\\mesh');
    await user.click(
      screen.getByRole('button', { name: 'Browse repository folder' }),
    );
    expect(path).toHaveValue('C:\\code\\mesh');
    expect(screen.getByRole('alert')).toHaveTextContent('Picker unavailable');
  });

  it('shows validation feedback instead of submitting a relative path', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(<ProjectImportDialog open suggestions={[]} onImport={onImport} />);

    await user.type(
      screen.getByLabelText('Repository path'),
      'relative/repository',
    );
    await user.click(screen.getByRole('button', { name: 'Import project' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter an absolute repository path.',
    );
    expect(onImport).not.toHaveBeenCalled();
  });

  it('disables repeat submissions while import is pending', async () => {
    const user = userEvent.setup();
    let resolveImport: ((value: typeof project) => void) | undefined;
    const onImport = vi.fn(
      () =>
        new Promise<typeof project>((resolve) => {
          resolveImport = resolve;
        }),
    );
    render(<ProjectImportDialog open suggestions={[]} onImport={onImport} />);

    await user.type(screen.getByLabelText('Repository path'), 'C:\\code\\mesh');
    await user.click(screen.getByRole('button', { name: 'Import project' }));

    expect(
      screen.getByRole('button', { name: 'Importing project…' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Importing project…' }),
    );
    expect(onImport).toHaveBeenCalledTimes(1);
    resolveImport?.(project);
  });

  it('opens the existing project after a duplicate import response', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(
      <ProjectImportDialog
        open
        suggestions={[]}
        onImported={onImported}
        onImport={vi.fn().mockRejectedValue({
          code: 'repository_already_imported',
          details: { project },
        })}
      />,
    );

    await user.type(screen.getByLabelText('Repository path'), 'C:\\code\\mesh');
    await user.click(screen.getByRole('button', { name: 'Import project' }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(project));
  });
});

const project = {
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\code\\mesh',
  discoveredAt: '2026-08-25T00:00:00.000Z',
  discoveryMetadata: {},
  repositoryIdentity: 'C:\\code\\mesh',
  revision: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  archivedAt: null,
};
