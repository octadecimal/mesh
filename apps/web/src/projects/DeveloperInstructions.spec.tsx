import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  taskActorSchema,
  type Project,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { DeveloperInstructions } from './DeveloperInstructions';

const project: Project = {
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:/code/mesh',
  repositoryIdentity: 'mesh',
  discoveredAt: '2026-08-25T00:00:00.000Z',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  archivedAt: null,
  discoveryMetadata: {},
  revision: 3,
  developerInstructions: {
    content: 'Run focused tests.',
    revision: 2,
    updatedAt: '2026-08-25T00:00:00.000Z',
    updatedBy: taskActorSchema.parse({ type: 'human', id: 'operator' }),
  },
};

describe('DeveloperInstructions', () => {
  it('keeps an editable local draft and saves it against the project revision', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DeveloperInstructions
        project={project}
        disabled={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByText('Instructions revision 2')).toBeDefined();
    const input = screen.getByLabelText('Developer instructions');
    await user.clear(input);
    await user.type(input, 'Commit only verified changes.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(input).toHaveValue('Run focused tests.');

    await user.clear(input);
    await user.type(input, 'Commit only verified changes.');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        content: 'Commit only verified changes.',
        expectedRevision: 3,
      }),
    );
  });

  it('disables editing while archived or disconnected and while a save is pending', async () => {
    const pending = deferred<void>();
    const user = userEvent.setup();
    const onSave = vi.fn(() => pending.promise);
    const { rerender } = render(
      <DeveloperInstructions project={project} disabled onSave={onSave} />,
    );

    expect(screen.getByLabelText('Developer instructions')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Save instructions' }),
    ).toBeDisabled();

    rerender(
      <DeveloperInstructions
        project={project}
        disabled={false}
        onSave={onSave}
      />,
    );
    await user.type(
      screen.getByLabelText('Developer instructions'),
      ' Updated.',
    );
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(
      screen.getByRole('button', { name: 'Saving instructions…' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Developer instructions')).toBeDisabled();
    pending.resolve();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save instructions' }),
      ).toBeEnabled(),
    );
  });

  it('preserves the draft and asks the user to wait for resync after a stale revision', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue({
      code: 'project_revision_conflict',
      message: 'The project was updated.',
      details: { project: { ...project, revision: 4 } },
    });
    const { rerender } = render(
      <DeveloperInstructions
        project={project}
        disabled={false}
        onSave={onSave}
      />,
    );

    const input = screen.getByLabelText('Developer instructions');
    await user.clear(input);
    await user.type(input, 'Keep my draft.');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server is at revision 4. Waiting for project resync.',
    );
    expect(input).toHaveValue('Keep my draft.');
    expect(
      screen.getByRole('button', { name: 'Save instructions' }),
    ).toBeDisabled();

    rerender(
      <DeveloperInstructions
        project={{
          ...project,
          revision: 4,
          developerInstructions: {
            ...project.developerInstructions,
            content: 'Server instructions.',
            revision: 3,
          },
        }}
        disabled={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The server is at revision 4. Waiting for project resync.',
    );
    expect(input).toHaveValue('Keep my draft.');
  });
});

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
