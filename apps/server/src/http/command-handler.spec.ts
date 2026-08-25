import { afterEach, describe, expect, it } from 'vitest';
import {
  idSchema,
  projectSchema,
  sessionSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { FakeClaudeSessionDriver } from '../claude/fake-driver.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { executeCommand } from './command-handler.js';

const now = '2026-08-24T00:00:00.000Z';

describe('executeCommand', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('does not decide an already-resolved permission request', async () => {
    const repositories = createTestRepositories();
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'w1',
        projectId: 'p1',
        type: 'shared',
        path: 'C:/code/mesh',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'Session',
        permissionMode: 'interactive',
        lifecycleState: 'idle',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('s1');
    driver.createdSessions[0]?.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-1',
      name: 'Bash',
      input: {},
    });
    for (let attempts = 0; attempts < 20; attempts += 1) {
      if (
        repositories.events
          .after('s1', 0)
          .some((event) => event.type === 'permission.requested')
      )
        break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    repositories.events.append(
      's1',
      {
        id: 'permission-resolved',
        occurredAt: now,
        type: 'permission.resolved',
        payload: {
          permissionId: 'permission-1',
          decision: 'denied',
          resolvedAt: now,
        },
      },
      {
        id: idSchema.parse('raw-resolved'),
        sessionId: idSchema.parse('s1'),
        capturedAt: now,
        payload: {},
      },
    );

    await expect(
      executeCommand(
        {
          protocolVersion: 1,
          idempotencyKey: 'permission-key',
          command: {
            type: 'permission.decide',
            payload: { permissionId: 'permission-1', decision: 'approve' },
          },
        },
        { ...repositories, registry, driver, billingConflicts: [] },
      ),
    ).rejects.toMatchObject({ code: 'invalid_session_state' });
    expect(driver.createdSessions[0]?.permissionDecisions).toEqual([]);
  });
});
