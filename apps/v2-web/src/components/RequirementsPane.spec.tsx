import { render, screen } from '@testing-library/react';
import type { ApprovedIntentLedger } from '@mesh/v2-contracts';
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
      targetUsers: ['Individuals'],
      desiredCapabilities: ['Add tasks'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Tasks complete'],
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
} as ApprovedIntentLedger;

describe('RequirementsPane', () => {
  it('renders the approved intent, all five record groups, metadata, provenance, and textual relationship endpoints', () => {
    render(<RequirementsPane intentLedger={intentLedger} />);

    expect(screen.getByText('Build Todo.')).toBeVisible();
    for (const group of [
      'Requirements',
      'Decisions',
      'Assumptions',
      'Questions',
      'Risks',
    ]) {
      expect(
        screen.getAllByRole('heading', { name: group }).at(-1),
      ).toBeVisible();
    }
    expect(screen.getByText('functional · approved · must')).toBeVisible();
    expect(screen.getByText('confirmed · high')).toBeVisible();
    expect(screen.getByText('answered · Use one list.')).toBeVisible();
    expect(
      screen.getByText('mitigated · medium · Keep the scope small.'),
    ).toBeVisible();
    expect(
      screen.getByText('decision statement constrains requirement statement'),
    ).toBeVisible();
    expect(screen.getByText('requirement source')).toBeVisible();
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
        intentLedger={{ ...intentLedger, records: [], relationships: [] }}
      />,
    );
    expect(
      screen.getByText('No ledger records are in this approved revision.'),
    ).toBeVisible();
    expect(
      screen.queryByText(/coverage|readiness|task/i),
    ).not.toBeInTheDocument();
  });

  it('projects every server-defined record lifecycle without deriving a new one', () => {
    const lifecycleRecords = [
      ...['proposed', 'approved', 'superseded', 'rejected', 'retired'].map(
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
        intentLedger={
          {
            ...intentLedger,
            records: lifecycleRecords.map((record) => ({
              ...intentLedger.records[0],
              recordId: `10000000-0000-4000-8000-0000000000${String(record.index).padStart(2, '0')}`,
              content: {
                statement: `Record ${record.index}`,
                rationale: 'Projected from the server.',
                ...record,
              },
            })),
          } as ApprovedIntentLedger
        }
      />,
    );

    for (const record of lifecycleRecords)
      expect(
        screen.getAllByText(record.status, { exact: false }).length,
      ).toBeGreaterThan(0);
  });
});
