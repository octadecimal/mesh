import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FakeClaudeSessionDriver } from './claude/fake-driver.js';
import { buildApp, createOriginPolicy } from './app.js';
import { SessionRegistry } from './runtime/session-registry.js';
import { TaskService } from './tasks/task-service.js';
import { createTestRepositories } from './test/create-test-database.js';
import type { DirectoryPicker } from './platform/directory-picker.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setup = (options?: {
  webRoot?: string;
  developmentOrigin?: string;
  directoryPicker?: Pick<DirectoryPicker, 'select'>;
}) => {
  const repositories = createTestRepositories();
  const driver = new FakeClaudeSessionDriver();
  const registry = new SessionRegistry({
    ...repositories,
    driver,
    closeDatabase: () => undefined,
  });
  const originPolicy = createOriginPolicy(options?.developmentOrigin);
  const taskService = new TaskService(repositories);
  originPolicy.setServedOrigin('http://127.0.0.1:3737');
  const app = buildApp({
    ...repositories,
    taskService,
    registry,
    driver,
    pathOptions: { baseDirectory: process.cwd() },
    billingConflicts: [],
    originPolicy,
    directoryPicker: options?.directoryPicker,
    webRoot: options?.webRoot,
  });
  cleanups.push(async () => {
    await app.close();
    await registry.shutdown();
    repositories.dispose();
  });
  return { app, originPolicy };
};

describe('local application security', () => {
  it.each(['http://evil.example', 'null'])(
    'rejects HTTP and socket origin %s with the same exact policy',
    async (origin) => {
      const { app } = setup();

      const http = await app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { origin },
      });
      const socket = await app.inject({
        method: 'GET',
        url: '/api/socket',
        headers: { connection: 'upgrade', upgrade: 'websocket', origin },
      });

      expect(http.statusCode).toBe(403);
      expect(socket.statusCode).toBe(403);
    },
  );

  it('allows only the actual served origin and the explicit Vite development origin', async () => {
    const { app } = setup({ developmentOrigin: 'http://127.0.0.1:4200' });

    const served = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { origin: 'http://127.0.0.1:3737' },
    });
    const vite = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { origin: 'http://127.0.0.1:4200' },
    });
    const lookalike = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { origin: 'http://127.0.0.1:3737/' },
    });

    expect(served.statusCode).toBe(200);
    expect(vite.statusCode).toBe(200);
    expect(lookalike.statusCode).toBe(403);
  });

  it('answers preflight only for the explicit Vite development origin', async () => {
    const { app } = setup({ developmentOrigin: 'http://127.0.0.1:4200' });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/commands',
      headers: {
        origin: 'http://127.0.0.1:4200',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:4200',
    );
  });

  it('serves built assets and falls back to the SPA without masking API misses', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'mesh-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<main>Mesh shell</main>');
    writeFileSync(join(webRoot, 'app.js'), 'window.mesh = true;');
    cleanups.push(() => rmSync(webRoot, { recursive: true, force: true }));
    const { app } = setup({ webRoot });

    const asset = await app.inject({ method: 'GET', url: '/app.js' });
    const spa = await app.inject({ method: 'GET', url: '/sessions/s1' });
    const apiMiss = await app.inject({ method: 'GET', url: '/api/missing' });
    const apiRoot = await app.inject({ method: 'GET', url: '/api' });

    expect(asset.body).toBe('window.mesh = true;');
    expect(spa.body).toBe('<main>Mesh shell</main>');
    expect(apiMiss.statusCode).toBe(404);
    expect(apiRoot.statusCode).toBe(404);
  });

  it('stops new commands and upgrades before process shutdown work begins', async () => {
    const { app, originPolicy } = setup();
    originPolicy.stopAccepting();

    const command = await app.inject({ method: 'POST', url: '/api/commands' });
    const socket = await app.inject({
      method: 'GET',
      url: '/api/socket',
      headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        origin: 'http://127.0.0.1:3737',
      },
    });

    expect(command.statusCode).toBe(503);
    expect(socket.statusCode).toBe(503);
  });

  it('applies origin and shutdown protections to folder selection', async () => {
    const { app, originPolicy } = setup({
      directoryPicker: { select: async () => 'C:/workspace' },
    });

    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/directories/select',
      headers: { origin: 'http://evil.example' },
      payload: {},
    });
    originPolicy.stopAccepting();
    const stopped = await app.inject({
      method: 'POST',
      url: '/api/directories/select',
      payload: {},
    });

    expect(crossOrigin.statusCode).toBe(403);
    expect(stopped.statusCode).toBe(503);
  });
});
