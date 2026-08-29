import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import {
  V2_PROTOCOL_VERSION,
  serverRealtimeMessageSchema,
  v2ProjectSnapshotSchema,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { FakeHarnessAdapter } from './executions/fake-harness';
import { startV2Server, type RunningV2Server } from './main';
import { approveV2GitExecutable } from './platform/process-runner';
import { createV2TestDatabase } from './test/create-v2-test-database';

const servers: RunningV2Server[] = [];
const directories: string[] = [];
const workspaceRoot = resolve(__dirname, '..', '..', '..');
const localRequire = createRequire(__filename);
let builtRoot: string | undefined;
let builtMain: string | undefined;
let builtSignalBridge: string | undefined;

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

const buildProductionEntrypoint = () => {
  if (builtMain && builtSignalBridge) {
    return { main: builtMain, signalBridge: builtSignalBridge };
  }
  builtRoot = mkdtempSync(join(workspaceRoot, '.mesh-v2-entrypoint-test-'));
  const migrations = join(builtRoot, 'migrations');
  mkdirSync(migrations);
  builtMain = join(builtRoot, 'main.js');
  builtSignalBridge = join(builtRoot, 'signal-bridge.cjs');
  execFileSync(
    process.execPath,
    [
      localRequire.resolve('esbuild/bin/esbuild'),
      'apps/v2-server/src/main.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:better-sqlite3',
      `--outfile=${builtMain}`,
    ],
    { cwd: workspaceRoot, shell: false, stdio: 'pipe' },
  );
  copyFileSync(
    join(
      workspaceRoot,
      'apps',
      'v2-server',
      'src',
      'db',
      'migrations',
      '001_foundation.sql',
    ),
    join(migrations, '001_foundation.sql'),
  );
  writeFileSync(
    builtSignalBridge,
    `process.on('message', (message) => {
  if (message?.type === 'mesh.v2.test.sigterm') {
    process.emit('SIGTERM');
    process.disconnect();
  }
});\n`,
  );
  return { main: builtMain, signalBridge: builtSignalBridge };
};

const startBuiltServer = async (
  childEnvironment: Readonly<Record<string, string | undefined>>,
) => {
  const built = buildProductionEntrypoint();
  const processEnvironment = { ...childEnvironment };
  if (processEnvironment.FORCE_COLOR !== undefined) {
    delete processEnvironment.NO_COLOR;
  }
  const readyLines: Array<{ type: 'mesh.v2.ready'; origin: string }> = [];
  let stderr = '';
  let stdoutBuffer = '';
  const child = spawn(
    process.execPath,
    ['-r', built.signalBridge, built.main],
    {
      cwd: workspaceRoot,
      env: processEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const ready = new Promise<{ type: 'mesh.v2.ready'; origin: string }>(
    (resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.once('exit', (code, signal) => {
        rejectReady(
          new Error(
            `V2 child exited before ready (${String(code)}/${String(signal)}): ${stderr}`,
          ),
        );
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/u);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const candidate = JSON.parse(line) as unknown;
          if (
            typeof candidate === 'object' &&
            candidate !== null &&
            (candidate as { type?: unknown }).type === 'mesh.v2.ready'
          ) {
            const parsed = candidate as {
              type: 'mesh.v2.ready';
              origin: string;
            };
            readyLines.push(parsed);
            resolveReady(parsed);
          }
        }
      });
    },
  );
  return {
    child,
    exited,
    ready: await ready,
    readyLines,
    stderr: () => stderr,
  };
};

type TestWebSocket = {
  on(event: 'message', listener: (data: unknown) => void): void;
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  send(value: string): void;
  close(): void;
};

const connectProjectSocket = async (
  origin: string,
  projectId: string,
  cursors: { domain: number; runtime: number },
) => {
  const websocketPackage = localRequire.resolve('ws', {
    paths: [dirname(localRequire.resolve('@fastify/websocket'))],
  });
  const WebSocketClient = localRequire(websocketPackage) as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => TestWebSocket;
  const socket = new WebSocketClient(
    `${origin.replace(/^http/u, 'ws')}/api/v2/realtime`,
    { headers: { origin } },
  );
  const messages: ServerRealtimeMessage[] = [];
  const waiters: Array<{
    predicate: (message: ServerRealtimeMessage) => boolean;
    resolve: (message: ServerRealtimeMessage) => void;
  }> = [];
  socket.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const message = serverRealtimeMessageSchema.parse(JSON.parse(text));
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  socket.send(
    JSON.stringify({
      type: 'v2.subscribe',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      cursors,
    }),
  );
  const waitFor = (predicate: (message: ServerRealtimeMessage) => boolean) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerRealtimeMessage>((resolveMessage) => {
      waiters.push({ predicate, resolve: resolveMessage });
    });
  };
  await waitFor((message) => message.type === 'v2.subscribed');
  return {
    socket,
    waitFor,
    close: () =>
      new Promise<void>((resolveClose) => {
        socket.once('close', resolveClose);
        socket.close();
      }),
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

afterAll(() => {
  if (!builtRoot || !existsSync(builtRoot)) return;
  const fromWorkspace = relative(workspaceRoot, builtRoot);
  if (
    fromWorkspace === '' ||
    fromWorkspace.startsWith('..') ||
    !builtRoot.includes('.mesh-v2-entrypoint-test-')
  ) {
    throw new Error('Refusing to remove an unverified V2 entrypoint build');
  }
  rmSync(builtRoot, { force: true, recursive: true });
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

  it('releases a configured fake hold and completes the durable execution', async () => {
    const fixture = createV2TestDatabase();
    const fake = new FakeHarnessAdapter();
    let heldResolve!: () => void;
    let completedResolve!: () => void;
    const held = new Promise<void>((resolve) => (heldResolve = resolve));
    const completed = new Promise<void>(
      (resolve) => (completedResolve = resolve),
    );
    fixture.database.close();
    try {
      const server = await startV2Server({
        environment: {
          ...(await environment(fixture.directory, fixture.path)),
          MESH_V2_FAKE_HOLD_AFTER_CURSOR: '2',
        },
        test: {
          adapter: fake,
          onPublished: (message) => {
            if (
              message.type === 'v2.runtime_event' &&
              message.event.adapterCursor === 2
            ) {
              heldResolve();
            }
            if (
              message.type === 'v2.domain_event' &&
              message.event.type === 'worker_execution.lifecycle_changed' &&
              message.event.payload.execution.lifecycle === 'completed'
            ) {
              completedResolve();
            }
          },
        },
      });
      servers.push(server);
      const response = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'worker_execution.start',
            projectId: fixture.project.id,
            profileId: fixture.profileRevision.profileId,
            profileRevision: fixture.profileRevision.revision,
            assignment: {
              kind: 'foundation-check',
              projectId: fixture.project.id,
              title: 'Check Todo',
              instructions: 'Inspect the Todo fixture.',
              fakeScenario: 'todo-foundation-v1',
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        execution?: { id: string };
      };
      await held;
      const heldSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((snapshotResponse) => snapshotResponse.json()),
      );
      expect(
        heldSnapshot.executions.find(
          (execution) => execution.id === result.execution?.id,
        ),
      ).toMatchObject({ lifecycle: 'running', lastAdapterCursor: 2 });

      server.releaseFakeHold();
      await completed;

      const completedSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((snapshotResponse) => snapshotResponse.json()),
      );
      expect(
        completedSnapshot.executions.find(
          (execution) => execution.id === result.execution?.id,
        ),
      ).toMatchObject({ lifecycle: 'completed', lastAdapterCursor: 6 });
      expect(fake.consumedAdapterCursors).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      fixture.close();
    }
  });

  it('runs the built entrypoint with one ready line, V2 routes, and signal shutdown', async () => {
    const fixture = createV2TestDatabase();
    const webRoot = temporaryDirectory();
    writeFileSync(join(webRoot, 'index.html'), '<h1>Built V2 marker</h1>');
    fixture.database.close();
    let childServer: Awaited<ReturnType<typeof startBuiltServer>> | undefined;
    try {
      childServer = await startBuiltServer({
        ...(await environment(fixture.directory, fixture.path)),
        MESH_V2_WEB_ROOT: webRoot,
      });
      expect(childServer.ready).toEqual({
        type: 'mesh.v2.ready',
        origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      });
      const snapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${childServer.ready.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const socket = await connectProjectSocket(
        childServer.ready.origin,
        fixture.project.id,
        snapshot.cursors,
      );
      await socket.close();
      const [rootResponse, directResponse, v1Response] = await Promise.all([
        fetch(`${childServer.ready.origin}/`),
        fetch(`${childServer.ready.origin}/projects/${fixture.project.id}`),
        fetch(`${childServer.ready.origin}/api`),
      ]);

      expect(await rootResponse.text()).toContain('Built V2 marker');
      expect(await directResponse.text()).toContain('Built V2 marker');
      expect(v1Response.status).toBe(404);
      if (process.platform === 'win32') {
        childServer.child.send({ type: 'mesh.v2.test.sigterm' });
      } else {
        childServer.child.kill('SIGTERM');
      }
      const exit = await childServer.exited;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(childServer.readyLines).toEqual([childServer.ready]);
      expect(childServer.stderr()).toBe('');
    } finally {
      if (
        childServer &&
        childServer.child.exitCode === null &&
        childServer.child.signalCode === null
      ) {
        childServer.child.kill('SIGKILL');
        await childServer.exited;
      }
      fixture.close();
    }
  });

  it('reconstructs and resumes a held execution after process loss before listen', async () => {
    const fixture = createV2TestDatabase();
    const restartedFake = new FakeHarnessAdapter();
    const publications: Array<{
      message: ServerRealtimeMessage;
      beforeListen: boolean;
    }> = [];
    let secondStarted = false;
    let completedResolve!: () => void;
    const completed = new Promise<void>(
      (resolveCompletion) => (completedResolve = resolveCompletion),
    );
    fixture.database.close();
    let first: Awaited<ReturnType<typeof startBuiltServer>> | undefined;
    try {
      first = await startBuiltServer({
        ...(await environment(fixture.directory, fixture.path)),
        MESH_V2_FAKE_HOLD_AFTER_CURSOR: '2',
      });
      const initialSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${first.ready.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const socket = await connectProjectSocket(
        first.ready.origin,
        fixture.project.id,
        initialSnapshot.cursors,
      );
      const startResponse = await fetch(
        `${first.ready.origin}/api/v2/commands`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            actor: { kind: 'human' },
            command: {
              type: 'worker_execution.start',
              projectId: fixture.project.id,
              profileId: fixture.profileRevision.profileId,
              profileRevision: fixture.profileRevision.revision,
              assignment: {
                kind: 'foundation-check',
                projectId: fixture.project.id,
                title: 'Restart Todo check',
                instructions: 'Prove durable restart.',
                fakeScenario: 'todo-foundation-v1',
              },
            },
          }),
        },
      );
      const startResult = (await startResponse.json()) as {
        ok: boolean;
        execution?: { id: string };
      };
      expect(startResult).toMatchObject({ ok: true });
      const executionId = startResult.execution?.id;
      if (!executionId) throw new Error('Start result omitted the execution');
      await socket.waitFor(
        (message) =>
          message.type === 'v2.runtime_event' &&
          message.event.executionId === executionId &&
          message.event.adapterCursor === 2,
      );
      const heldSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${first.ready.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      expect(
        heldSnapshot.executions.find(
          (execution) => execution.id === executionId,
        ),
      ).toMatchObject({
        lifecycle: 'running',
        lastAdapterCursor: 2,
        nativeHandle: expect.stringMatching(/^fake:v1:/u),
      });
      await socket.close();
      first.child.kill('SIGKILL');
      await first.exited;
      expect(first.readyLines).toEqual([first.ready]);

      const second = await startV2Server({
        environment: await environment(fixture.directory, fixture.path),
        test: {
          adapter: restartedFake,
          onPublished: (message) => {
            publications.push({ message, beforeListen: !secondStarted });
            if (
              message.type === 'v2.domain_event' &&
              message.event.type === 'worker_execution.lifecycle_changed' &&
              message.event.payload.execution.id === executionId &&
              message.event.payload.execution.lifecycle === 'completed'
            ) {
              completedResolve();
            }
          },
        },
      });
      secondStarted = true;
      servers.push(second);
      await completed;

      const recoveredEvents = publications.filter(
        ({ message }) =>
          (message.type === 'v2.runtime_event' &&
            message.event.executionId === executionId) ||
          (message.type === 'v2.domain_event' &&
            message.event.type === 'worker_execution.lifecycle_changed' &&
            message.event.payload.execution.id === executionId),
      );
      expect(restartedFake.resumeCount).toBe(1);
      expect(restartedFake.consumedAdapterCursors).toEqual([3, 4, 5, 6]);
      expect(
        recoveredEvents.flatMap(({ message }) =>
          message.type === 'v2.runtime_event'
            ? [message.event.adapterCursor]
            : [],
        ),
      ).toEqual([3, 4, 5, 6]);
      expect(recoveredEvents.every(({ beforeListen }) => beforeListen)).toBe(
        true,
      );
      const recoveredSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${second.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      expect(
        recoveredSnapshot.executions.find(
          (execution) => execution.id === executionId,
        ),
      ).toMatchObject({ lifecycle: 'completed', lastAdapterCursor: 6 });
    } finally {
      if (
        first &&
        first.child.exitCode === null &&
        first.child.signalCode === null
      ) {
        first.child.kill('SIGKILL');
        await first.exited;
      }
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
