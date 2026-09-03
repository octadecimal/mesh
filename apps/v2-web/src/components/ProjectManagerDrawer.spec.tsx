import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { approvedIntentLedgerSchema } from '@mesh/v2-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectManagerDrawer,
  type ProjectManagerSection,
} from './ProjectManagerDrawer';

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

const approvedIntentLedger = approvedIntentLedgerSchema.parse({
  projectIntent: {
    id: '55555555-5555-4555-8555-555555555555',
    projectId,
    revision: 1,
    proposalId: '66666666-6666-4666-8666-666666666666',
    approvedBy: 'human',
    approvedAt: '2026-09-03T00:00:00.000Z',
    content: {
      goal: 'Keep project manager drafts.',
      targetUsers: ['Operators'],
      desiredCapabilities: ['Plan delivery'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Drafts survive tab switches'],
      rationale: 'Drafts are session work.',
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: '77777777-7777-4777-8777-777777777777',
          rationale: 'The operator requested delivery planning.',
        },
      ],
    },
  },
  ledger: {
    id: '88888888-8888-4888-8888-888888888888',
    projectId,
    revision: 1,
    proposalId: '66666666-6666-4666-8666-666666666666',
    approvedBy: 'human',
    approvedAt: '2026-09-03T00:00:00.000Z',
  },
  records: [
    {
      recordId: '99999999-9999-4999-8999-999999999999',
      projectId,
      revision: 1,
      proposalId: '66666666-6666-4666-8666-666666666666',
      approvedBy: 'human',
      approvedAt: '2026-09-03T00:00:00.000Z',
      content: {
        type: 'requirement',
        statement: 'Preserve draft text.',
        rationale: 'Operators should not lose work.',
        kind: 'quality',
        status: 'approved',
        priority: 'must',
      },
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: '77777777-7777-4777-8777-777777777777',
          rationale: 'The operator requested delivery planning.',
        },
      ],
    },
  ],
  relationships: [],
});

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
  initiallyOpen = false,
  initialSection = 'intent',
  drawerDeliveryPlan = deliveryPlan,
}: {
  currentProjectId?: string;
  currentProjectName?: string;
  pinned?: boolean;
  initiallyOpen?: boolean;
  initialSection?: ProjectManagerSection;
  drawerDeliveryPlan?: ComponentProps<
    typeof ProjectManagerDrawer
  >['deliveryPlan'];
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [section, setSection] = useState<ProjectManagerSection>(initialSection);
  return (
    <ProjectManagerDrawer
      projectId={currentProjectId}
      projectName={currentProjectName}
      open={open}
      pinned={pinned}
      section={section}
      composerFocusRequest={0}
      onOpenChange={setOpen}
      onPinnedChange={vi.fn()}
      onSectionChange={setSection}
      onNavigate={vi.fn()}
      intent={intent}
      deliveryPlan={drawerDeliveryPlan}
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
        section="intent"
        composerFocusRequest={0}
        onOpenChange={vi.fn()}
        onPinnedChange={onPinnedChange}
        onSectionChange={vi.fn()}
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

  it('reserves the pinned drawer width only while its panel is open', async () => {
    const user = userEvent.setup();
    render(<Harness pinned />);

    const trigger = screen.getByRole('button', { name: 'Project manager' });
    expect(trigger.closest('.v2-pm-drawer')).not.toHaveClass(
      'v2-pm-drawer-open',
    );

    await user.click(trigger);
    expect(trigger.closest('.v2-pm-drawer')).toHaveClass('v2-pm-drawer-open');

    await user.click(
      screen.getByRole('button', { name: 'Close project manager' }),
    );
    expect(trigger.closest('.v2-pm-drawer')).not.toHaveClass(
      'v2-pm-drawer-open',
    );
  });

  it('renders the selected planning section and switches sections', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        pinned
        initiallyOpen
        initialSection="delivery-plan"
        drawerDeliveryPlan={{ ...deliveryPlan, cycle: activeDeliveryCycle }}
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

  it('keeps a nonempty delivery draft when the start form remounts after a tab switch', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        pinned
        initiallyOpen
        drawerDeliveryPlan={{
          ...deliveryPlan,
          approvedIntentLedger,
          profiles: [profile],
        }}
      />,
    );

    await user.click(screen.getByRole('tab', { name: 'Delivery Plan' }));
    await user.click(screen.getByRole('button', { name: 'Plan delivery' }));
    const composer = screen.getByRole('textbox', {
      name: 'Message to project manager',
    });
    await user.clear(composer);
    await user.type(composer, 'Keep the operator draft.');

    await user.click(screen.getByRole('tab', { name: 'Intent' }));
    await user.click(screen.getByRole('tab', { name: 'Delivery Plan' }));
    await user.click(screen.getByRole('button', { name: 'Plan delivery' }));

    expect(
      screen.getByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveValue('Keep the operator draft.');
  });

  it('forces a stored pinned preference into an overlay on narrow screens', () => {
    setNarrow(true);
    render(
      <ProjectManagerDrawer
        projectId={projectId}
        projectName="Mesh"
        open
        pinned
        section="intent"
        composerFocusRequest={0}
        onOpenChange={vi.fn()}
        onPinnedChange={vi.fn()}
        onSectionChange={vi.fn()}
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
