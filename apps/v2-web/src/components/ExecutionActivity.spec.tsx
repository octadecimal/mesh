import { render, screen } from '@testing-library/react';
import type { RuntimeEvent, WorkerExecution } from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import { ExecutionActivity, type ChildActivity } from './ExecutionActivity';

const execution: WorkerExecution = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: '11111111-1111-4111-8111-111111111111',
  profileId: '33333333-3333-4333-8333-333333333333',
  profileRevision: 1,
  assignment: {
    kind: 'foundation-check',
    projectId: '11111111-1111-4111-8111-111111111111',
    title: 'Todo foundation worker',
    instructions: 'Inspect the Todo repository.',
    fakeScenario: 'todo-foundation-v1',
  },
  profileSnapshot: {
    profileId: '33333333-3333-4333-8333-333333333333',
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: 'mesh.dev/v1alpha1',
      kind: 'WorkerProfile',
      metadata: {
        name: 'todo-worker',
        displayName: 'Todo worker',
        scope: 'global',
      },
      spec: {
        assignmentKinds: ['foundation-check'],
        preferredRuntime: { harness: 'fake', model: 'deterministic' },
        alternatives: [],
        requiredCapabilities: ['execution.stream'],
        skills: { preferred: [], required: [] },
        instructions: 'Inspect.',
        outputSchema: 'mesh.dev/foundation-report/v1',
      },
    },
    digest: 'b'.repeat(64),
  },
  skillRequests: {
    preferred: [{ id: 'test-driven-development' }],
    required: [{ id: 'verification-before-completion' }],
  },
  resolvedSkills: [
    {
      requested: { id: 'test-driven-development' },
      mode: 'preferred',
      resolution: {
        kind: 'mesh-native-fallback',
        workflow: 'mesh.foundation-check/v1',
      },
    },
    {
      requested: { id: 'verification-before-completion' },
      mode: 'required',
      resolution: { kind: 'unavailable', reason: 'Not installed' },
    },
  ],
  capabilitySnapshot: {
    adapterId: 'fake',
    capabilities: ['execution.stream'],
    skills: [],
    exactResume: true,
  },
  adapterId: 'fake',
  model: 'deterministic',
  nativeHandle: 'opaque-handle',
  lifecycle: 'running',
  revision: 4,
  lastAdapterCursor: 8,
  lastRuntimeSequence: 12,
  replacementForExecutionId: null,
  failure: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  endedAt: null,
};

const children: readonly ChildActivity[] = [
  {
    id: 'child-1',
    title: 'Inspect package layout',
    lifecycle: 'running',
  },
  { id: 'child-2', title: 'Read package.json', lifecycle: 'completed' },
];

describe('ExecutionActivity', () => {
  it('renders skill outcomes and nested child activity without provider details by default', () => {
    render(
      <ExecutionActivity
        execution={execution}
        childActivities={children}
        projectCursors={{ domain: 4, runtime: 12 }}
      />,
    );

    expect(
      screen.getByRole('article', { name: 'Todo foundation worker' }),
    ).toBeVisible();
    expect(screen.getByText('Preferred skill fallback')).toBeVisible();
    expect(screen.getByText('Required skill unavailable')).toBeVisible();
    const childActivity = screen.getByRole('list', {
      name: 'Child activity for Todo foundation worker',
    });
    expect(childActivity).toHaveTextContent('Inspect package layout');
    expect(childActivity).toHaveTextContent('Read package.json');
    expect(screen.getByText('opaque-handle')).not.toBeVisible();
  });

  it('keeps provider-specific details inside the diagnostics disclosure', () => {
    render(
      <ExecutionActivity
        execution={execution}
        childActivities={[]}
        diagnosticId="raw-1"
        projectCursors={{ domain: 23, runtime: 29 }}
      />,
    );

    expect(screen.getByText('Adapter ID')).not.toBeVisible();
    screen.getByText('Diagnostics').click();
    expect(screen.getByText('Adapter ID')).toBeVisible();
    expect(screen.getByText('opaque-handle')).toBeVisible();
    expect(screen.getByText('raw-1')).toBeVisible();
    expect(screen.getByText('Execution revision')).toBeVisible();
    expect(screen.getByText('Adapter cursor')).toBeVisible();
    expect(screen.getByText('8')).toBeVisible();
    expect(screen.getByText('23')).toBeVisible();
    expect(screen.getByText('29')).toBeVisible();
  });

  it('shows normalized completion and child activity without changing lifecycle', () => {
    const runtimeActivity: readonly RuntimeEvent[] = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        projectId: execution.projectId,
        executionId: execution.id,
        diagnosticId: '66666666-6666-4666-8666-666666666666',
        sequence: 12,
        adapterCursor: 2,
        occurredAt: '2026-08-28T00:00:02.000Z',
        type: 'worker_execution.child_started',
        payload: { childId: 'todo-check', title: 'Todo check' },
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        projectId: execution.projectId,
        executionId: execution.id,
        diagnosticId: '88888888-8888-4888-8888-888888888888',
        sequence: 13,
        adapterCursor: 6,
        occurredAt: '2026-08-28T00:00:06.000Z',
        type: 'worker_execution.completed',
        payload: { outcome: 'completed' },
      },
    ];

    render(
      <ExecutionActivity
        execution={execution}
        runtimeActivity={runtimeActivity}
        projectCursors={{ domain: 4, runtime: 13 }}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('running');
    const activity = screen.getByRole('list', {
      name: 'Runtime activity for Todo foundation worker',
    });
    expect(screen.getByText('child.started')).toBeVisible();
    expect(screen.getByText('Todo check')).toBeVisible();
    expect(activity).toHaveTextContent('Execution completed');
    expect(activity).not.toHaveTextContent(runtimeActivity[0].diagnosticId);
  });
});

export { execution as executionFixture };
