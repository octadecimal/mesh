import {
  V2_PROTOCOL_VERSION,
  type V2CommandEnvelope,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';

import { createV2Api, V2HttpError } from './client';

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
