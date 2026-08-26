import { taskActorSchema } from '@mesh-session-platform/contracts';
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
});

const project = {
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:/code/mesh',
  discoveredAt: '2026-08-25T00:00:00.000Z',
  discoveryMetadata: {},
};
