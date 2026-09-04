import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('delegates the Mesh destination through native navigation', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(
      <AppShell
        route={{ page: 'inbox' }}
        health={{ status: 'ok' }}
        onNavigate={onNavigate}
      >
        <p>Inbox body</p>
      </AppShell>,
    );

    await user.click(screen.getByRole('link', { name: 'Mesh' }));

    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('marks the current destination and delegates native navigation', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(
      <AppShell
        route={{ page: 'inbox' }}
        health={{ status: 'ok' }}
        onNavigate={onNavigate}
      >
        <p>Inbox body</p>
      </AppShell>,
    );

    expect(
      screen.getByRole('navigation', { name: 'Global navigation' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(screen.getByRole('link', { name: 'Runs' }));
    expect(onNavigate).toHaveBeenCalledWith('/runs');
    expect(
      screen.queryByRole('button', { name: /project manager/i }),
    ).toBeNull();
    expect(screen.getByRole('main')).toHaveTextContent('Inbox body');
    expect(screen.getByRole('status')).toHaveTextContent(
      'System health: operational',
    );
  });
});
