import {
  taskActorSchema,
  type ProjectSnapshot,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { MeshApi } from './client';

describe('MeshApi', () => {
  it('preserves a duplicate-import error and the existing project for the import flow', async () => {
    const api = new MeshApi({
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: {
              code: 'repository_already_imported',
              message: 'This Git repository is already imported',
              details: { project },
            },
          }),
      }),
    });

    await expect(
      api.command({
        type: 'project.import',
        payload: {
          repositoryPath: 'C:/code/mesh',
          actor: taskActorSchema.parse({ type: 'human', id: 'operator' }),
        },
      }),
    ).rejects.toMatchObject({
      code: 'repository_already_imported',
      details: { project },
    });
  });

  it('parses project snapshots with their complete run aggregates', async () => {
    const api = new MeshApi({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(runSnapshot),
      }),
    });

    await expect(api.projectSnapshot('project-1')).resolves.toMatchObject({
      runs: [runSnapshot.runs[0]],
      projectRunLimits: { maxConcurrency: 4 },
    });
  });

  it('rejects malformed project run snapshots before they reach the projection', async () => {
    const api = new MeshApi({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...runSnapshot,
            runs: [{ ...runSnapshot.runs[0], state: 'unknown' }],
          }),
      }),
    });

    await expect(api.projectSnapshot('project-1')).rejects.toThrow();
  });

  it('rejects cross-project and duplicate runs before they reach the projection', async () => {
    for (const runs of [
      [{ ...runSnapshot.runs[0], projectId: 'project-2' }],
      [runSnapshot.runs[0], { ...runSnapshot.runs[0] }],
    ]) {
      const api = new MeshApi({
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ...runSnapshot, runs }),
        }),
      });

      await expect(api.projectSnapshot('project-1')).rejects.toThrow();
    }
  });

  it('loads paginated plan summaries and full plan details from read-only routes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(planHistoryPage),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(planDetails),
      });
    const api = new MeshApi({ fetch: fetcher });

    await expect(
      api.projectPlanHistory('project-1', 'plan-before'),
    ).resolves.toEqual(planHistoryPage);
    await expect(
      api.projectPlanDetails('project-1', 'plan-1'),
    ).resolves.toEqual(planDetails);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/projects/project-1/plans?before=plan-before',
      undefined,
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/projects/project-1/plans/plan-1',
      undefined,
    );
  });

  it('rejects malformed plan history and details before they reach the UI', async () => {
    const api = new MeshApi({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ plans: [{ id: 'invalid' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ...planDetails, proposals: [{}] }),
        }),
    });

    await expect(api.projectPlanHistory('project-1')).rejects.toThrow();
    await expect(
      api.projectPlanDetails('project-1', 'plan-1'),
    ).rejects.toThrow();
  });
});

const project = {
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:/code/mesh',
  discoveredAt: '2026-08-25T00:00:00.000Z',
  discoveryMetadata: {},
};

const runSnapshot = {
  protocolVersion: 1,
  project: {
    ...project,
    repositoryIdentity: 'mesh',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    archivedAt: null,
    revision: 1,
  },
  tasks: [],
  attempts: [],
  transitions: [],
  repairs: [],
  runs: [
    {
      id: 'run-1',
      projectId: project.id,
      revision: 1,
      concurrency: 2,
      state: 'running',
      completionReason: null,
      startedAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      completedAt: null,
      items: [],
    },
  ],
  projectRunLimits: { maxConcurrency: 4 },
  cursor: 0,
} satisfies ProjectSnapshot;

const plan = {
  id: 'plan-1',
  projectId: 'project-1',
  goal: 'Plan the next milestone.',
  constraints: [],
  nonGoals: [],
  policyVersion: 'pm-v1',
  status: 'awaiting_review' as const,
  revision: 2,
  currentBaseId: 'base-1',
  currentSessionId: 'pm-session-1',
  latestProposalOrdinal: 0,
  feedback: [],
  attention: null,
  createdBy: { type: 'human' as const, id: 'operator' },
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:01:00.000Z',
  terminalAt: null,
  terminalBy: null,
  terminalReason: null,
};

const planHistoryPage = {
  plans: [
    {
      id: 'plan-approved',
      projectId: 'project-1',
      goal: 'Plan the previous milestone.',
      status: 'approved' as const,
      revision: 3,
      latestProposalOrdinal: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:02:00.000Z',
      terminalAt: '2026-08-26T00:02:00.000Z',
    },
  ],
  nextAfter: 'plan-approved',
};

const planDetails = {
  plan,
  bases: [
    {
      id: 'base-1',
      planId: plan.id,
      ordinal: 1,
      repositoryIdentity: 'mesh',
      tasks: [],
      dependencies: [],
      projectArchivedAt: null,
      projectRevision: 1,
      policyRevision: 1,
      createdAt: plan.createdAt,
    },
  ],
  proposals: [],
  feedback: [],
};
