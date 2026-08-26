import {
  projectSchema,
  taskActorSchema,
  type Project,
} from '@mesh-session-platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestRepositories } from '../test/create-test-database.js';

const at = '2026-08-26T00:00:00.000Z';

const project = (): Project =>
  projectSchema.parse({
    id: 'project-1',
    displayName: 'Project',
    repositoryPath: 'C:/code/project',
    discoveredAt: at,
    discoveryMetadata: {},
  });

describe('ProjectRepository QA configuration', () => {
  const repositories: Array<ReturnType<typeof createTestRepositories>> = [];

  afterEach(() => repositories.splice(0).forEach((repo) => repo.dispose()));

  it('updates QA configuration only at the expected project revision', () => {
    const repo = createTestRepositories();
    repositories.push(repo);
    repo.projects.create(project());

    const updated = repo.projects.updateQaConfiguration(
      'project-1',
      1,
      {
        instructions: { content: 'Run the full verification suite.' },
        reviewPolicy: 'autonomous_review',
      },
      taskActorSchema.parse({ type: 'human', id: 'human-1' }),
    );

    expect(updated).toMatchObject({
      revision: 2,
      qaConfiguration: {
        instructions: {
          content: 'Run the full verification suite.',
          revision: 2,
          updatedBy: { type: 'human', id: 'human-1' },
        },
        reviewPolicy: 'autonomous_review',
        revision: 2,
        updatedBy: { type: 'human', id: 'human-1' },
      },
    });
    expect(
      repo.projects.updateQaConfiguration(
        'project-1',
        1,
        {
          instructions: { content: 'Stale write' },
          reviewPolicy: 'manual',
        },
        taskActorSchema.parse({ type: 'human', id: 'human-2' }),
      ),
    ).toBeUndefined();
  });
});
