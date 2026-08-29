import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
  v2ProjectSnapshotSchema,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeHarnessAdapter } from './executions/fake-harness';
import { startV2Server, type RunningV2Server } from './main';
import { approveV2GitExecutable } from './platform/process-runner';
import { createV2TestDatabase } from './test/create-v2-test-database';

const servers: RunningV2Server[] = [];
const directories: string[] = [];

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-v2-server-test-'));
  directories.push(directory);
  return directory;
};

const environment = async (root: string, databasePath: string) => {
  const git = await approveV2GitExecutable({
    pathValue: process.env.PATH ?? process.env.Path,
    workspaceRoot: root,
  });
  return {
    ...process.env,
    NODE_ENV: 'test',
    MESH_V2_HOST: '127.0.0.1',
    MESH_V2_PORT: '0',
    MESH_V2_WORKSPACE_ROOT: root,
    MESH_V2_DATABASE_PATH: databasePath,
    MESH_V2_GIT_EXECUTABLE: git.path,
  };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) {
    const resolved = resolve(directory);
    const fromTemp = relative(resolve(tmpdir()), resolved);
    if (
      fromTemp === '' ||
      fromTemp.startsWith('..') ||
      !resolved.includes('mesh-v2-server-test-')
    ) {
      throw new Error(
        'Refusing to remove an unverified V2 server test directory',
      );
    }
    rmSync(resolved, { force: true, recursive: true });
  }
});

describe('startV2Server', () => {
  it('binds an ephemeral loopback origin and serves only the explicit V2 web root', async () => {
    const root = temporaryDirectory();
    const webRoot = join(root, 'v2-web');
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, 'index.html'), '<h1>V2 marker</h1>');
    const server = await startV2Server({
      environment: await environment(root, join(root, 'mesh-v2.sqlite')),
      test: { adapter: new FakeHarnessAdapter(), webRoot },
    });
    servers.push(server);

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(
      await fetch(`${server.origin}/`).then((response) => response.text()),
    ).toContain('V2 marker');
    expect((await fetch(`${server.origin}/api`)).status).toBe(404);
    expect(() => server.releaseFakeHold()).not.toThrow();
  });

  it('publishes reconciliation changes before accepting the first snapshot', async () => {
    const fixture = createV2TestDatabase();
    const publications: ServerRealtimeMessage[] = [];
    fixture.database.close();
    try {
      const server = await startV2Server({
        environment: await environment(fixture.directory, fixture.path),
        test: {
          adapter: new FakeHarnessAdapter(),
          onPublished: (message) => publications.push(message),
        },
      });
      servers.push(server);

      const snapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      expect(snapshot.executions[0]?.lifecycle).toBe('failed');
      expect(
        publications.some(
          (message) =>
            message.type === 'v2.domain_event' &&
            message.event.type === 'worker_execution.lifecycle_changed' &&
            message.event.payload.execution.lifecycle === 'failed',
        ),
      ).toBe(true);
    } finally {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      fixture.close();
    }
  });

  it('returns one close promise and rejects new commands after shutdown starts', async () => {
    const root = temporaryDirectory();
    const server = await startV2Server({
      environment: await environment(root, join(root, 'mesh-v2.sqlite')),
      test: { adapter: new FakeHarnessAdapter() },
    });
    servers.push(server);

    const closing = server.close();
    const response = await fetch(`${server.origin}/api/v2/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => undefined);
    await closing;

    expect(response === undefined || response.status === 503).toBe(true);
    await expect(server.close()).resolves.toBeUndefined();
  });
});
