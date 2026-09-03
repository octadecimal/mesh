import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { V2ProjectSnapshot } from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { attentionFromSnapshots } from '../app/global-projection';
import {
  projectSnapshotFixture,
  runningExecutionFixture,
} from '../test/project-snapshot-fixture';
import { ProjectOverview } from './ProjectOverview';

const approvedIntent = {
  records: Array.from({ length: 14 }, (_, index) => ({
    recordId: `REQ-${index + 1}`,
    content: { type: 'requirement' },
  })),
} as unknown as NonNullable<V2ProjectSnapshot['intentLedger']>;

const approvedPlan = {
  plan: { id: 'plan-1', revision: 3 },
} as unknown as NonNullable<V2ProjectSnapshot['deliveryPlan']>;

const snapshotWith = (
  values: Partial<V2ProjectSnapshot>,
): V2ProjectSnapshot => ({ ...projectSnapshotFixture, ...values });

describe('ProjectOverview', () => {
  it('summarizes approved intent and delivery plan with its canonical action', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const snapshot = snapshotWith({
      intentLedger: approvedIntent,
      deliveryPlan: approvedPlan,
      attentionItems: [],
      executions: [],
    });

    render(
      <ProjectOverview
        snapshot={snapshot}
        attention={attentionFromSnapshots([snapshot])}
        onNavigate={onNavigate}
      />,
    );

    expect(
      screen.getByRole('heading', { name: snapshot.project.displayName }),
    ).toBeVisible();
    expect(screen.getByText('14 requirements')).toBeVisible();
    await user.click(
      screen.getByRole('link', { name: 'Review delivery plan' }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      `/projects/${snapshot.project.id}/plans`,
    );
  });

  it('guides a project without approved intent to planning', () => {
    const snapshot = snapshotWith({
      executions: [],
      attentionItems: [],
    });

    render(
      <ProjectOverview
        snapshot={snapshot}
        attention={attentionFromSnapshots([snapshot])}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText('Project intent is not approved.')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Plan project intent' }),
    ).toHaveAttribute('href', `/projects/${snapshot.project.id}/plans`);
  });

  it('guides approved intent without a delivery plan to planning', () => {
    const snapshot = snapshotWith({
      intentLedger: approvedIntent,
      executions: [],
      attentionItems: [],
    });

    render(
      <ProjectOverview
        snapshot={snapshot}
        attention={attentionFromSnapshots([snapshot])}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText('Delivery plan is not approved.')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Create delivery plan' }),
    ).toHaveAttribute('href', `/projects/${snapshot.project.id}/plans`);
  });

  it('keeps a stale delivery plan visible and points to the Board', () => {
    const snapshot = snapshotWith({
      intentLedger: approvedIntent,
      deliveryPlan: approvedPlan,
      executions: [],
      attentionItems: [],
      board: { ...projectSnapshotFixture.board, stale: true },
    });

    render(
      <ProjectOverview
        snapshot={snapshot}
        attention={attentionFromSnapshots([snapshot])}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText('Delivery plan is stale.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review Board' })).toHaveAttribute(
      'href',
      `/projects/${snapshot.project.id}/board`,
    );
  });

  it('summarizes actionable Board work', () => {
    const snapshot = snapshotWith({
      intentLedger: approvedIntent,
      deliveryPlan: approvedPlan,
      executions: [],
      attentionItems: [],
      board: {
        ...projectSnapshotFixture.board,
        emptyReason: null,
        totalTaskCount: 1,
        matchedTaskCount: 1,
        cards: [
          {
            taskId: 'T-21',
            taskCurrentRevision: 8,
            title: 'Ship project navigation',
            outcome: 'Project artifacts are URL-controlled.',
            readiness: { state: 'actionable' },
          } as V2ProjectSnapshot['board']['cards'][number],
        ],
      },
    });

    render(
      <ProjectOverview
        snapshot={snapshot}
        attention={attentionFromSnapshots([snapshot])}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText('1 actionable task')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Board' })).toHaveAttribute(
      'href',
      `/projects/${snapshot.project.id}/board?task=T-21`,
    );
  });

  it('separates attention-required and active execution summaries', () => {
    const attentionSnapshot = snapshotWith({
      executions: [
        {
          ...runningExecutionFixture,
          lifecycle: 'attention_required',
        },
      ],
    });
    const { rerender } = render(
      <ProjectOverview
        snapshot={attentionSnapshot}
        attention={attentionFromSnapshots([attentionSnapshot])}
        onNavigate={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Required verification skill is unavailable.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review run' })).toHaveAttribute(
      'href',
      `/projects/${attentionSnapshot.project.id}/runs?run=${runningExecutionFixture.id}`,
    );

    rerender(
      <ProjectOverview
        snapshot={projectSnapshotFixture}
        attention={attentionFromSnapshots([projectSnapshotFixture])}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText('1 active execution')).toBeVisible();
    expect(
      within(
        screen.getByRole('region', { name: 'Active executions' }),
      ).getByText('Todo foundation worker'),
    ).toBeVisible();
  });
});
