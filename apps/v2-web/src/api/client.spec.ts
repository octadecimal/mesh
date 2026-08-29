import {
  V2_PROTOCOL_VERSION,
  type V2CommandEnvelope,
  type V2ProjectSnapshot,
  type RetainedRuntimeWindow,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';

import { createV2Api, V2HttpError, V2ResyncRequiredError } from './client';

const systemSnapshot: V2SystemSnapshot = {
  protocolVersion: V2_PROTOCOL_VERSION,
  health: { status: 'ok' },
  projects: [],
  globalProfiles: [],
};

const projectId = '00000000-0000-4000-8000-000000000001';

const projectSnapshot = {
  protocolVersion: V2_PROTOCOL_VERSION,
  project: {
    id: projectId,
    displayName: 'Mesh',
    repositoryIdentity: 'repo-1',
    repositoryPath: 'C:\\code\\mesh',
    gitCommonDirectory: 'C:\\code\\mesh\\.git',
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  profiles: [],
  executions: [],
  attentionItems: [],
  cursors: { domain: 2, runtime: 5 },
} satisfies V2ProjectSnapshot;

const runtimeWindow = {
  lowWater: 6,
  highWater: 6,
  events: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      projectId,
      executionId: '00000000-0000-4000-8000-000000000003',
      diagnosticId: '00000000-0000-4000-8000-000000000004',
      sequence: 6,
      adapterCursor: 6,
      occurredAt: '2026-08-28T00:00:06.000Z',
      type: 'worker_execution.completed',
      payload: { outcome: 'completed' },
    },
  ],
} satisfies RetainedRuntimeWindow;

describe('createV2Api', () => {
  it('parses snapshots and encodes project identifiers', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(systemSnapshot), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(projectSnapshot), { status: 200 }),
      );
    const api = createV2Api({ baseUrl: 'http://mesh.test', fetcher });

    await expect(api.systemSnapshot()).resolves.toEqual(systemSnapshot);
    await expect(api.projectSnapshot('project/1')).resolves.toEqual(
      projectSnapshot,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://mesh.test/api/v2/snapshot',
      'http://mesh.test/api/v2/projects/project%2F1/snapshot',
    ]);
  });

  it('fails closed when a successful response violates its schema', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...systemSnapshot, extra: true })),
      );

    await expect(createV2Api({ fetcher }).systemSnapshot()).rejects.toThrow();
  });

  it('requests and parses a retained runtime replay window', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(runtimeWindow)));

    await expect(
      createV2Api({ baseUrl: 'http://mesh.test/', fetcher }).runtimeReplay(
        'project/1',
        5,
      ),
    ).resolves.toEqual(runtimeWindow);
    expect(fetcher).toHaveBeenCalledWith(
      'http://mesh.test/api/v2/projects/project%2F1/events?stream=runtime&after=5',
      { signal: undefined },
    );
  });

  it('fails closed for malformed runtime windows and replay cursors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...runtimeWindow, extra: true })),
      );
    const api = createV2Api({ fetcher });

    await expect(api.runtimeReplay(projectId, 5)).rejects.toThrow();
    await expect(api.runtimeReplay(projectId, 1.5)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('distinguishes a parsed retained-gap response from ordinary HTTP errors', async () => {
    const retainedGap = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'v2.resync_required',
          protocolVersion: V2_PROTOCOL_VERSION,
          projectId,
          reason: 'retained_gap',
        }),
        { status: 409 },
      ),
    );

    await expect(
      createV2Api({ fetcher: retainedGap }).runtimeReplay(projectId, 2),
    ).rejects.toMatchObject({
      name: 'V2ResyncRequiredError',
      projectId,
      reason: 'retained_gap',
    } satisfies Partial<V2ResyncRequiredError>);

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ type: 'v2.resync_required', projectId }),
          { status: 409 },
        ),
      );
    await expect(
      createV2Api({ fetcher: malformed }).runtimeReplay(projectId, 2),
    ).rejects.toMatchObject({
      name: 'V2HttpError',
      status: 409,
      code: 'internal_error',
    } satisfies Partial<V2HttpError>);
  });

  it('surfaces a stable server error and hides an invalid error body', async () => {
    const stable = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'project_not_found', message: 'Project missing.' },
        }),
        { status: 404 },
      ),
    );
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'database details' } }), {
        status: 500,
      }),
    );

    await expect(
      createV2Api({ fetcher: stable }).projectSnapshot('project-1'),
    ).rejects.toMatchObject({
      name: 'V2HttpError',
      status: 404,
      code: 'project_not_found',
      message: 'Project missing.',
    } satisfies Partial<V2HttpError>);
    await expect(
      createV2Api({ fetcher: invalid }).systemSnapshot(),
    ).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
      message: 'Request failed.',
    } satisfies Partial<V2HttpError>);
  });

  it('passes command bodies and abort signals through unchanged', async () => {
    const command: V2CommandEnvelope = {
      idempotencyKey: 'register-1',
      actor: { kind: 'human' },
      command: { type: 'project.register', repositoryPath: 'C:\\repo' },
    };
    const result = {
      ok: true as const,
      commandType: 'project.register' as const,
      project: projectSnapshot.project,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    const controller = new AbortController();

    await expect(
      createV2Api({ fetcher }).command(command, controller.signal),
    ).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledWith('/api/v2/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  });

  it('does not translate an abort rejection', async () => {
    const aborted = new DOMException('Stopped', 'AbortError');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(aborted);

    await expect(
      createV2Api({ fetcher }).systemSnapshot(new AbortController().signal),
    ).rejects.toBe(aborted);
  });
});
