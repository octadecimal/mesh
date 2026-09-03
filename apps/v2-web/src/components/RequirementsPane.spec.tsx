import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { approvedIntentLedgerSchema } from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import { RequirementsPane } from './RequirementsPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const records = [
  ['requirement', { kind: 'functional', status: 'approved', priority: 'must' }],
  ['decision', { status: 'active' }],
  ['assumption', { status: 'confirmed', confidence: 'high' }],
  ['question', { status: 'answered', resolution: 'Use one list.' }],
  [
    'risk',
    {
      status: 'mitigated',
      severity: 'medium',
      mitigation: 'Keep the scope small.',
    },
  ],
] as const;

const intentLedger = {
  projectIntent: {
    id: '33333333-3333-4333-8333-333333333333',
    projectId,
    revision: 1,
    proposalId,
    approvedBy: 'human',
    approvedAt: '2026-08-29T00:00:00.000Z',
    content: {
      goal: 'Build Todo.',
      targetUsers: ['Individuals', 'Students'],
      desiredCapabilities: ['Add tasks', 'Complete tasks'],
      constraints: ['Works offline'],
      nonGoals: ['Team administration'],
      successConditions: ['Tasks complete', 'Progress persists'],
      rationale: 'Small first release.',
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: '44444444-4444-4444-8444-444444444444',
          rationale: 'Requested by the operator.',
        },
      ],
    },
  },
  ledger: {
    id: '55555555-5555-4555-8555-555555555555',
    projectId,
    revision: 1,
    proposalId,
    approvedBy: 'human',
    approvedAt: '2026-08-29T00:00:00.000Z',
  },
  records: records.map(([type, extra], index) => ({
    recordId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    projectId,
    revision: 1,
    proposalId,
    approvedBy: 'human',
    approvedAt: '2026-08-29T00:00:00.000Z',
    content: {
      type,
      statement: `${type} statement`,
      rationale: `${type} rationale`,
      ...extra,
    },
    provenance: [
      {
        kind: 'conversation_turn',
        turnId: '44444444-4444-4444-8444-444444444444',
        rationale: `${type} source`,
      },
    ],
  })),
  relationships: [
    {
      kind: 'constrains',
      fromRecordId: '00000000-0000-4000-8000-000000000002',
      toRecordId: '00000000-0000-4000-8000-000000000001',
    },
  ],
};

const approvedIntentLedger = approvedIntentLedgerSchema.parse(intentLedger);

describe('RequirementsPane', () => {
  it('renders counted semantic groups, compact record metadata, provenance, and textual relationship endpoints', async () => {
    const user = userEvent.setup();
    render(<RequirementsPane intentLedger={approvedIntentLedger} />);

    expect(screen.getByText('Build Todo.')).toBeVisible();
    for (const intentValue of [
      'Individuals',
      'Students',
      'Add tasks',
      'Complete tasks',
      'Works offline',
      'Team administration',
      'Tasks complete',
      'Progress persists',
      'Small first release.',
    ])
      expect(screen.getByText(intentValue, { exact: false })).toBeVisible();
    for (const group of [
      'Requirements',
      'Decisions',
      'Assumptions',
      'Questions',
      'Risks',
    ]) {
      const heading = screen.getByRole('heading', { name: `${group} · 1` });
      expect(heading).toBeVisible();
      expect(heading.tagName).toBe('H3');
    }
    expect(
      screen.getByText('Requirement · Functional · Approved · Must'),
    ).toBeVisible();
    expect(screen.getByText('Assumption · Confirmed · High')).toBeVisible();
    expect(
      screen.getByText('Question · Answered · Use one list.'),
    ).toBeVisible();
    expect(
      screen.getByText('Risk · Mitigated · Medium · Keep the scope small.'),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Relationships' }).parentElement,
    ).toHaveTextContent(
      '00000000-0000-4000-8000-000000000002 · Decision · decision statement constrains 00000000-0000-4000-8000-000000000001 · Requirement · requirement statement',
    );
    const requirementCard = screen.getByRole('article', {
      name: 'requirement statement',
    });
    await user.click(
      within(requirementCard).getByText('Revision and provenance'),
    );
    expect(
      within(requirementCard).getByRole('list', {
        name: 'Provenance for requirement statement',
      }),
    ).toHaveTextContent('requirement source');
  });

  it('counts each category and keeps relationship direction explicit', () => {
    const extraRequirement = (suffix: number) => ({
      ...approvedIntentLedger.records[0],
      recordId: `00000000-0000-4000-8000-00000000000${suffix}`,
      content: {
        ...approvedIntentLedger.records[0].content,
        statement: `requirement statement ${suffix}`,
      },
    });
    const extraDecision = {
      ...approvedIntentLedger.records[1],
      recordId: '00000000-0000-4000-8000-000000000008',
      content: {
        ...approvedIntentLedger.records[1].content,
        statement: 'decision statement 8',
      },
    };
    render(
      <RequirementsPane
        intentLedger={{
          ...approvedIntentLedger,
          records: [
            ...approvedIntentLedger.records,
            extraRequirement(6),
            extraRequirement(7),
            extraDecision,
          ],
          relationships: [
            ...approvedIntentLedger.relationships,
            {
              kind: 'depends_on',
              fromRecordId: extraRequirement(6).recordId,
              toRecordId: extraRequirement(7).recordId,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Requirements · 3' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Decisions · 2' }),
    ).toBeVisible();
    expect(
      screen.getByText(`depends on ${extraRequirement(7).recordId}`),
    ).toBeVisible();
  });

  it('keeps approval and record revision depth in native disclosures', async () => {
    const user = userEvent.setup();
    render(<RequirementsPane intentLedger={approvedIntentLedger} />);

    const approval = screen.getByText('Approval history').closest('details');
    const card = screen.getByRole('article', {
      name: 'requirement statement',
    });
    const revision = within(card)
      .getByText('Revision and provenance')
      .closest('details');
    expect(approval).not.toBeNull();
    expect(revision).not.toBeNull();
    if (!approval || !revision) throw new Error('Expected ledger disclosures');
    expect(approval).not.toHaveAttribute('open');
    expect(revision).not.toHaveAttribute('open');

    await user.click(screen.getByText('Approval history'));
    expect(within(approval).getByText('Approved by')).toBeVisible();
    expect(
      within(approval).getByText('2026-08-29T00:00:00.000Z'),
    ).toBeVisible();
    await user.click(within(card).getByText('Revision and provenance'));
    expect(within(card).getByText('Revision 1')).toBeVisible();
    expect(
      within(card).getByRole('list', {
        name: 'Provenance for requirement statement',
      }),
    ).toBeVisible();
  });

  it('renders loading, error, empty-before-approval, and no-record states without inventing coverage or readiness', () => {
    const { rerender } = render(
      <RequirementsPane loading intentLedger={null} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading requirements',
    );

    rerender(
      <RequirementsPane
        error="Unable to refresh requirements"
        intentLedger={null}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to refresh requirements',
    );

    rerender(<RequirementsPane intentLedger={null} />);
    expect(
      screen.getByText('No approved intent or requirements yet.'),
    ).toBeVisible();

    rerender(
      <RequirementsPane
        intentLedger={{
          ...approvedIntentLedger,
          records: [],
          relationships: [],
        }}
      />,
    );
    expect(
      screen.getByText('No ledger records are in this approved revision.'),
    ).toBeVisible();
    expect(screen.queryByText(/coverage|readiness/i)).not.toBeInTheDocument();
  });

  it('projects every server-defined record lifecycle without deriving a new one', () => {
    const lifecycleRecords = [
      ...['approved', 'superseded', 'rejected', 'retired'].map(
        (status, index) => ({
          type: 'requirement',
          status,
          kind: 'quality',
          priority: 'could',
          index,
        }),
      ),
      ...['active', 'superseded', 'retired'].map((status, index) => ({
        type: 'decision',
        status,
        index: index + 5,
      })),
      ...['active', 'confirmed', 'invalidated', 'retired'].map(
        (status, index) => ({
          type: 'assumption',
          status,
          confidence: 'low',
          index: index + 8,
        }),
      ),
      ...['open', 'answered', 'retired'].map((status, index) => ({
        type: 'question',
        status,
        resolution: status === 'answered' ? 'Resolved.' : undefined,
        index: index + 12,
      })),
      ...['open', 'mitigated', 'accepted', 'retired'].map((status, index) => ({
        type: 'risk',
        status,
        severity: 'low',
        mitigation: 'Review it.',
        index: index + 15,
      })),
    ];
    render(
      <RequirementsPane
        intentLedger={approvedIntentLedgerSchema.parse({
          ...approvedIntentLedger,
          relationships: [],
          records: lifecycleRecords.map(({ index, ...record }) => ({
            ...approvedIntentLedger.records[0],
            recordId: `10000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
            content: {
              statement: `Record ${index}`,
              rationale: 'Projected from the server.',
              ...record,
            },
          })),
        })}
      />,
    );

    for (const record of lifecycleRecords)
      expect(
        screen.getAllByText(record.status, { exact: false }).length,
      ).toBeGreaterThan(0);
  });

  it('renders stable relationship identities, human relationship labels, and complete intent provenance', () => {
    render(<RequirementsPane intentLedger={approvedIntentLedger} />);
    expect(
      screen.getByRole('heading', { name: 'Relationships' }).parentElement,
    ).toHaveTextContent(
      '00000000-0000-4000-8000-000000000002 · Decision · decision statement constrains 00000000-0000-4000-8000-000000000001 · Requirement · requirement statement',
    );
    expect(
      screen.getByRole('list', { name: 'Approved intent provenance' }),
    ).toHaveTextContent(
      '44444444-4444-4444-8444-444444444444 · Requested by the operator.',
    );
    expect(screen.getByText('Ledger revision 1')).toBeVisible();
  });
});
