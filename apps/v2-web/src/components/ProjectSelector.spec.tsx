import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { V2SystemSnapshot } from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSelector } from './ProjectSelector';

const systemSnapshot: V2SystemSnapshot = {
  protocolVersion: 'mesh.v2/1',
  health: { status: 'ok' },
  projects: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Todo',
      repositoryIdentity: 'todo-identity',
      repositoryPath: 'C:\\repos\\todo',
      gitCommonDirectory: 'C:\\repos\\todo\\.git',
      headCommit: 'a'.repeat(40),
      revision: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
  ],
  globalProfiles: [],
};

describe('ProjectSelector', () => {
  it('submits a repository path from the ready selector', async () => {
    const user = userEvent.setup();
    const onRegister = vi.fn();

    render(
      <ProjectSelector
        model={{ status: 'ready', snapshot: systemSnapshot, submitting: false }}
        onRegister={onRegister}
      />,
    );

    await user.type(screen.getByLabelText('Repository path'), 'C:\\repos\\new');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(onRegister).toHaveBeenCalledWith('C:\\repos\\new');
    expect(screen.getByRole('list', { name: 'Known projects' })).toHaveTextContent(
      'Todo',
    );
  });

  it('renders loading, empty, disconnected, and invalid-path states with safe controls', () => {
    const { rerender } = render(
      <ProjectSelector model={{ status: 'loading' }} onRegister={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading projects');
    expect(screen.getByRole('button', { name: 'Add project' })).toBeDisabled();

    rerender(
      <ProjectSelector
        model={{
          status: 'ready',
          snapshot: { ...systemSnapshot, projects: [] },
          submitting: true,
        }}
        onRegister={vi.fn()}
      />,
    );
    expect(screen.getByText('No projects have been added yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeDisabled();
    expect(screen.getByText('Adding the project is in progress.')).toBeVisible();

    rerender(
      <ProjectSelector
        model={{ status: 'disconnected', message: 'Connection lost' }}
        onRegister={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('button', { name: 'Add project' })).toBeDisabled();
    expect(screen.getByText('Reconnect before adding a project.')).toBeVisible();

    rerender(
      <ProjectSelector
        model={{ status: 'error', snapshot: systemSnapshot, message: 'Repository path is invalid' }}
        onRegister={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Repository path is invalid');

    rerender(
      <ProjectSelector
        model={{ status: 'error', snapshot: systemSnapshot, message: 'Repository identity conflicts with Todo' }}
        onRegister={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Repository identity conflicts with Todo');
  });

  it('prevents an empty repository submission', () => {
    const onRegister = vi.fn();
    render(
      <ProjectSelector
        model={{ status: 'ready', snapshot: systemSnapshot, submitting: false }}
        onRegister={onRegister}
      />,
    );

    fireEvent.submit(screen.getByRole('form', { name: 'Add a project' }));

    expect(onRegister).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a repository path.')).toBeVisible();
  });
});
