import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { projectSchema, type Project } from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { QaSettings } from './QaSettings';

const timestamp = '2026-08-26T00:00:00.000Z';
const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\code\\mesh',
  discoveredAt: timestamp,
  revision: 4,
  qaConfiguration: {
    instructions: {
      content: 'Verify every acceptance criterion.',
      revision: 2,
      updatedAt: timestamp,
      updatedBy: null,
    },
    reviewPolicy: 'manual',
    revision: 2,
    updatedAt: timestamp,
    updatedBy: null,
  },
});

describe('QaSettings', () => {
  it('saves controlled instructions and policy against the QA configuration revision', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<QaSettings project={project} disabled={false} onSave={onSave} />);

    expect(screen.getByText('QA configuration revision 2')).toBeVisible();
    await user.clear(screen.getByLabelText('QA instructions'));
    await user.type(
      screen.getByLabelText('QA instructions'),
      'Run focused verification.',
    );
    await user.click(screen.getByRole('button', { name: 'Save QA settings' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        content: 'Run focused verification.',
        reviewPolicy: 'manual',
        expectedRevision: 2,
      }),
    );
  });

  it('requires explicit subscription-quota confirmation before autonomous review', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<QaSettings project={project} disabled={false} onSave={onSave} />);

    await user.selectOptions(
      screen.getByLabelText('Review policy'),
      'autonomous_review',
    );
    await user.click(screen.getByRole('button', { name: 'Save QA settings' }));

    const dialog = screen.getByRole('dialog', {
      name: 'Enable autonomous review',
    });
    expect(dialog).toHaveTextContent('Claude subscription quota');
    expect(dialog).toHaveTextContent('never API billing');
    expect(onSave).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'Enable autonomous review' }),
    );
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        content: 'Verify every acceptance criterion.',
        reviewPolicy: 'autonomous_review',
        expectedRevision: 2,
      }),
    );
  });

  it('traps consent focus, dismisses on Escape, and restores the save trigger', async () => {
    const user = userEvent.setup();
    render(
      <QaSettings
        project={project}
        disabled={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Review policy'),
      'autonomous_review',
    );
    const save = screen.getByRole('button', { name: 'Save QA settings' });
    await user.click(save);

    const keepManual = screen.getByRole('button', {
      name: 'Keep manual review',
    });
    const enable = screen.getByRole('button', {
      name: 'Enable autonomous review',
    });
    await waitFor(() => expect(keepManual).toHaveFocus());
    await user.tab();
    expect(enable).toHaveFocus();
    await user.tab();
    expect(keepManual).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: 'Enable autonomous review' }),
    ).not.toBeInTheDocument();
    expect(save).toHaveFocus();
  });

  it('preserves a stale draft until authoritative project refresh and explains non-retroactive disabling', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue({
      code: 'project_revision_conflict',
      details: {
        project: {
          ...project,
          revision: 5,
          qaConfiguration: { ...project.qaConfiguration, revision: 3 },
        },
      },
    });
    const autonomous = {
      ...project,
      qaConfiguration: {
        ...project.qaConfiguration,
        reviewPolicy: 'autonomous_review' as const,
      },
    };
    const { rerender } = render(
      <QaSettings project={autonomous} disabled={false} onSave={onSave} />,
    );

    expect(
      screen.getByText(/does not interrupt a running QA session/i),
    ).toBeVisible();
    expect(
      screen.getByText(/does not process existing review tasks retroactively/i),
    ).toBeVisible();
    await user.clear(screen.getByLabelText('QA instructions'));
    await user.type(
      screen.getByLabelText('QA instructions'),
      'Keep this draft.',
    );
    await user.selectOptions(screen.getByLabelText('Review policy'), 'manual');
    await user.click(screen.getByRole('button', { name: 'Save QA settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'server is at QA configuration revision 3',
    );
    expect(screen.getByLabelText('QA instructions')).toHaveValue(
      'Keep this draft.',
    );
    expect(
      screen.getByRole('button', { name: 'Save QA settings' }),
    ).toBeDisabled();

    rerender(
      <QaSettings
        project={
          {
            ...autonomous,
            revision: 5,
            qaConfiguration: { ...autonomous.qaConfiguration, revision: 3 },
          } as Project
        }
        disabled={false}
        onSave={onSave}
      />,
    );
    expect(screen.getByLabelText('QA instructions')).toHaveValue(
      'Keep this draft.',
    );
  });
});
