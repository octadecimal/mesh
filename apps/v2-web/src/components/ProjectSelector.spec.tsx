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
  globalProfiles: [
    {
      profileId: '33333333-3333-4333-8333-333333333333',
      projectId: null,
      scope: 'global',
      name: 'foundation-worker',
      displayName: 'Foundation worker',
      approvedRevision: 2,
    },
  ],
};

describe('ProjectSelector', () => {
  it('adds and selects a repository through callback-only controls', async () => {
    const user = userEvent.setup();
    const onAddAndSelectProject = vi.fn();
    const onSelectProject = vi.fn();

    render(
      <ProjectSelector
        model={{
          status: 'ready',
          snapshot: systemSnapshot,
          submitting: false,
          registration: { enabled: true },
        }}
        onAddAndSelectProject={onAddAndSelectProject}
        onSelectProject={onSelectProject}
        v1GuidanceHref="/guidance/v1"
      />,
    );

    await user.type(screen.getByLabelText('Repository path'), 'C:\\repos\\new');
    await user.click(screen.getByRole('button', { name: 'Add and select project' }));
    await user.click(screen.getByRole('button', { name: 'Select Todo' }));

    expect(onAddAndSelectProject).toHaveBeenCalledWith('C:\\repos\\new');
    expect(onSelectProject).toHaveBeenCalledWith(systemSnapshot.projects[0].id);
    expect(screen.getByRole('list', { name: 'Known projects' })).toHaveTextContent(
      'Todo',
    );
  });

  it('renders loading, empty, disconnected, and invalid-path states with safe controls', () => {
    const { rerender } = render(
      <ProjectSelector model={{ status: 'loading' }} onAddAndSelectProject={vi.fn()} onSelectProject={vi.fn()} v1GuidanceHref="/guidance/v1" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading projects');
    expect(screen.getByRole('button', { name: 'Add and select project' })).toBeDisabled();

    rerender(
      <ProjectSelector
        model={{
          status: 'ready',
          snapshot: { ...systemSnapshot, projects: [] },
          submitting: true,
          registration: { enabled: true },
        }}
        onAddAndSelectProject={vi.fn()}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );
    expect(screen.getByText('No projects have been added yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add and select project' })).toBeDisabled();
    expect(screen.getByText('Adding the project is in progress.')).toBeVisible();

    rerender(
      <ProjectSelector
        model={{ status: 'disconnected', message: 'Connection lost' }}
        onAddAndSelectProject={vi.fn()}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('button', { name: 'Add and select project' })).toBeDisabled();
    expect(screen.getByText('Reconnect before adding a project.')).toBeVisible();

    rerender(
      <ProjectSelector
        model={{ status: 'error', snapshot: systemSnapshot, message: 'Repository path is invalid', registration: { enabled: false, disabledReason: 'Correct the repository path first.' } }}
        onAddAndSelectProject={vi.fn()}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Repository path is invalid');

    rerender(
      <ProjectSelector
        model={{ status: 'error', snapshot: systemSnapshot, message: 'Repository identity conflicts with Todo', registration: { enabled: true } }}
        onAddAndSelectProject={vi.fn()}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Repository identity conflicts with Todo');
  });

  it('prevents an empty repository submission', () => {
    const onRegister = vi.fn();
    render(
      <ProjectSelector
        model={{ status: 'ready', snapshot: systemSnapshot, submitting: false, registration: { enabled: true } }}
        onAddAndSelectProject={onRegister}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );

    fireEvent.submit(screen.getByRole('form', { name: 'Add and select a project' }));

    expect(onRegister).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a repository path.')).toBeVisible();
  });

  it('shows health, approved global profiles, and disables registration at the audit barrier', () => {
    render(
      <ProjectSelector
        model={{
          status: 'ready',
          snapshot: {
            ...systemSnapshot,
            health: { status: 'audit_barrier_tripped', error: { code: 'audit_barrier_tripped', message: 'Audit writes failed' } },
          },
          submitting: false,
          registration: { enabled: true },
        }}
        onAddAndSelectProject={vi.fn()}
        onSelectProject={vi.fn()}
        v1GuidanceHref="/guidance/v1"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Audit writes failed');
    expect(screen.getByText('Foundation worker · revision 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'V1 operating guidance' })).toHaveAttribute('href', '/guidance/v1');
    expect(screen.getByRole('button', { name: 'Add and select project' })).toBeDisabled();
  });

  it('keeps an error snapshot visible and lets its explicit retry availability control registration', async () => {
    const user = userEvent.setup();
    const onAddAndSelectProject = vi.fn();
    const onSelectProject = vi.fn();
    render(
      <ProjectSelector
        model={{
          status: 'error',
          snapshot: systemSnapshot,
          message: 'Repository identity conflicts with Todo',
          registration: { enabled: true },
        }}
        onAddAndSelectProject={onAddAndSelectProject}
        onSelectProject={onSelectProject}
        v1GuidanceHref="/served-v1-guidance"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('System health: operational');
    expect(screen.getByRole('list', { name: 'Known projects' })).toHaveTextContent('Todo');
    expect(screen.getByRole('list', { name: 'Approved global profiles' })).toHaveTextContent('Foundation worker');
    expect(screen.getByRole('button', { name: 'Add and select project' })).toBeEnabled();
    await user.type(screen.getByLabelText('Repository path'), 'C:\\repos\\retry');
    await user.click(screen.getByRole('button', { name: 'Add and select project' }));
    await user.click(screen.getByRole('button', { name: 'Select Todo' }));
    expect(onAddAndSelectProject).toHaveBeenCalledWith('C:\\repos\\retry');
    expect(onSelectProject).toHaveBeenCalledWith(systemSnapshot.projects[0].id);
    expect(screen.getByRole('link', { name: 'V1 operating guidance' })).toHaveAttribute('href', '/served-v1-guidance');
  });
});
