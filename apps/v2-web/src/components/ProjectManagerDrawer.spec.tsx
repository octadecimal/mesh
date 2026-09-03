import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectManagerDrawer } from './ProjectManagerDrawer';

const projectId = '11111111-1111-4111-8111-111111111111';
const profile = {
  profileId: '22222222-2222-4222-8222-222222222222',
  projectId,
  scope: 'project' as const,
  name: 'mesh-pm',
  displayName: 'Mesh PM',
  approvedRevision: 1,
};

const intent = {
  connection: { status: 'ready' } as const,
  profiles: [profile],
  submitting: false,
  onSubmitTurn: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onAbandon: vi.fn(),
};

const deliveryPlan = {
  approvedIntentLedger: null,
  deliveryPlan: null,
  planStale: false,
  connection: { status: 'ready' } as const,
  profiles: [],
  submitting: false,
  onSubmit: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onAbandon: vi.fn(),
};

const activeDeliveryCycle = {
  purpose: {
    kind: 'delivery_plan' as const,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  cycle: {
    id: '33333333-3333-4333-8333-333333333333',
    projectId,
    lifecycle: 'awaiting_human' as const,
    revision: 1,
    profileId: profile.profileId,
    profileRevision: 1,
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    endedAt: null,
  },
  turns: [],
  questions: [],
  proposals: [],
  deliveryPlanProposals: [],
};

function setNarrow(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '(max-width: 56rem)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function Harness({
  currentProjectId = projectId,
  currentProjectName = 'Mesh',
  pinned = false,
}: {
  currentProjectId?: string;
  currentProjectName?: string;
  pinned?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ProjectManagerDrawer
      projectId={currentProjectId}
      projectName={currentProjectName}
      open={open}
      pinned={pinned}
      onOpenChange={setOpen}
      onPinnedChange={vi.fn()}
      onNavigate={vi.fn()}
      intent={intent}
      deliveryPlan={deliveryPlan}
    />
  );
}

describe('ProjectManagerDrawer', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setNarrow(false);
  });

  it('opens a project-bound overlay, closes with Escape, and restores trigger focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Project manager' });
    await user.click(trigger);
    expect(
      screen.getByRole('dialog', { name: 'Project manager · Mesh' }),
    ).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('renders pinned content as an aside and persists pin changes', async () => {
    const user = userEvent.setup();
    const onPinnedChange = vi.fn();
    render(
      <ProjectManagerDrawer
        projectId={projectId}
        projectName="Mesh"
        open
        pinned
        onOpenChange={vi.fn()}
        onPinnedChange={onPinnedChange}
        onNavigate={vi.fn()}
        intent={intent}
        deliveryPlan={deliveryPlan}
      />,
    );

    expect(
      screen.getByRole('complementary', { name: 'Project manager · Mesh' }),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Unpin project manager' }),
    );
    expect(onPinnedChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('mesh.v2.pm-pinned')).toBe('false');
  });

  it('defaults to the active planning section and switches sections', async () => {
    const user = userEvent.setup();
    render(
      <ProjectManagerDrawer
        projectId={projectId}
        projectName="Mesh"
        open
        pinned
        onOpenChange={vi.fn()}
        onPinnedChange={vi.fn()}
        onNavigate={vi.fn()}
        intent={intent}
        deliveryPlan={{ ...deliveryPlan, cycle: activeDeliveryCycle }}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Delivery Plan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
      'Delivery draft',
    );
    expect(
      sessionStorage.getItem(`mesh.v2.pm-draft:${projectId}:delivery_plan`),
    ).toBe('Delivery draft');
    await user.click(screen.getByRole('tab', { name: 'Intent' }));
    expect(screen.getByRole('tab', { name: 'Intent' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('stores drafts by project and purpose without leaking on project switches', async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Project manager' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
      'Mesh draft',
    );
    expect(sessionStorage.getItem(`mesh.v2.pm-draft:${projectId}:intent`)).toBe(
      'Mesh draft',
    );

    const otherProjectId = '44444444-4444-4444-8444-444444444444';
    view.rerender(
      <Harness currentProjectId={otherProjectId} currentProjectName="Other" />,
    );
    expect(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveValue('');
    await user.type(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
      'Other draft',
    );
    expect(
      sessionStorage.getItem(`mesh.v2.pm-draft:${otherProjectId}:intent`),
    ).toBe('Other draft');

    view.rerender(<Harness />);
    expect(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveValue('Mesh draft');
  });

  it('forces a stored pinned preference into an overlay on narrow screens', () => {
    setNarrow(true);
    render(
      <ProjectManagerDrawer
        projectId={projectId}
        projectName="Mesh"
        open
        pinned
        onOpenChange={vi.fn()}
        onPinnedChange={vi.fn()}
        onNavigate={vi.fn()}
        intent={intent}
        deliveryPlan={deliveryPlan}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: 'Project manager · Mesh' }),
    ).toBeVisible();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
