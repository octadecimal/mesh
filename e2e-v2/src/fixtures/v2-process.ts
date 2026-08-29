import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { expect, type Page } from '@playwright/test';
import {
  V2_PROTOCOL_VERSION,
  retainedDomainWindowSchema,
  retainedRuntimeWindowSchema,
  serverRealtimeMessageSchema,
  v2CommandResultSchema,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  type ClientRealtimeMessage,
  type RetainedDomainWindow,
  type RetainedRuntimeWindow,
  type ServerRealtimeMessage,
  type V2CommandEnvelope,
  type V2ProjectSnapshot,
} from '@mesh/v2-contracts';
import Database from 'better-sqlite3';
import {
  assertContainedPath,
  createTodoRepository,
} from './todo-repository.js';

type ReadyLine = { type: 'mesh.v2.ready'; origin: string };
type RunningChild = {
  process: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  origin: string;
  readyLines: ReadyLine[];
  stderr: () => string;
};

const workspaceRoot = resolve(__dirname, '..', '..', '..');
const serverMain = join(workspaceRoot, 'dist', 'apps', 'v2-server', 'main.js');
const webRoot = join(workspaceRoot, 'dist', 'apps', 'v2-web');

const hashFile = async (path: string) => {
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
};

const minimalSystemEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
};

const parseOrigin = (value: string) => {
  const origin = new URL(value);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !Number.isInteger(Number(origin.port)) ||
    Number(origin.port) <= 0 ||
    origin.origin !== value
  ) {
    throw new Error(`V2 server returned an invalid loopback origin: ${value}`);
  }
  return origin.origin;
};

const childExit = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    },
  );

const terminateExactChild = async (
  child: RunningChild,
  signal: NodeJS.Signals,
) => {
  if (child.process.exitCode !== null || child.process.signalCode !== null)
    return;
  if (!child.process.pid || !child.process.kill(signal)) {
    throw new Error(
      `Could not terminate owned V2 server PID ${String(child.process.pid)}`,
    );
  }
  await child.exited;
  expect(child.readyLines).toHaveLength(1);
};

export class V2ProcessFixture {
  readonly databasePath: string;
  readonly todoRepository: string;
  private child: RunningChild | undefined;
  private projectIdValue: string | undefined;
  private executionIdValue: string | undefined;
  private heldSnapshot: V2ProjectSnapshot | undefined;

  private constructor(
    readonly fixtureRoot: string,
    todoRepository: string,
  ) {
    this.todoRepository = todoRepository;
    this.databasePath = assertContainedPath(
      fixtureRoot,
      join(fixtureRoot, 'mesh-v2.sqlite'),
    );
  }

  static async createTodo() {
    const root = await mkdtemp(join(resolve(tmpdir()), 'mesh-v2-e2e-'));
    const relation = relative(resolve(tmpdir()), resolve(root));
    if (!relation || relation.startsWith('..')) {
      throw new Error(
        `Temporary fixture escaped the system temp root: ${root}`,
      );
    }
    const repository = await createTodoRepository(root);
    return new V2ProcessFixture(root, repository);
  }

  get origin() {
    if (!this.child) throw new Error('V2 server is not running');
    return this.child.origin;
  }

  get serverPid() {
    const pid = this.child?.process.pid;
    if (!pid) throw new Error('V2 server has no PID');
    return pid;
  }

  get projectId() {
    if (!this.projectIdValue)
      throw new Error('Todo project has not been registered');
    return this.projectIdValue;
  }

  get executionId() {
    if (!this.executionIdValue)
      throw new Error('Todo execution has not been started');
    return this.executionIdValue;
  }

  async start(options: { holdAfterAdapterCursor?: number } = {}) {
    if (this.child) throw new Error('V2 server is already running');
    this.child = await this.spawnServer(
      this.databasePath,
      options.holdAfterAdapterCursor,
    );
    return this.origin;
  }

  private async spawnServer(
    databasePath: string,
    holdAfterAdapterCursor?: number,
  ) {
    await Promise.all([access(serverMain), access(webRoot)]);
    const environment: NodeJS.ProcessEnv = {
      ...minimalSystemEnvironment(),
      NODE_ENV: 'test',
      MESH_V2_PORT: '0',
      MESH_V2_WORKSPACE_ROOT: this.fixtureRoot,
      MESH_V2_DATABASE_PATH: databasePath,
      MESH_V2_WEB_ROOT: webRoot,
      HOME: this.fixtureRoot,
      USERPROFILE: this.fixtureRoot,
    };
    if (holdAfterAdapterCursor !== undefined) {
      environment.MESH_V2_FAKE_HOLD_AFTER_CURSOR = String(
        holdAfterAdapterCursor,
      );
    }
    const child = spawn(process.execPath, [serverMain], {
      cwd: workspaceRoot,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = childExit(child);
    const readyLines: ReadyLine[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const ready = new Promise<string>((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.once('exit', (code, signal) =>
        rejectReady(
          new Error(
            `V2 server exited before ready (${String(code)}/${String(signal)}): ${stderr}`,
          ),
        ),
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/u);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          let candidate: unknown;
          try {
            candidate = JSON.parse(line);
          } catch {
            rejectReady(new Error(`Unexpected V2 server stdout: ${line}`));
            continue;
          }
          if (
            typeof candidate !== 'object' ||
            candidate === null ||
            (candidate as { type?: unknown }).type !== 'mesh.v2.ready' ||
            typeof (candidate as { origin?: unknown }).origin !== 'string'
          ) {
            rejectReady(new Error(`Unexpected V2 server stdout: ${line}`));
            continue;
          }
          readyLines.push(candidate as ReadyLine);
          if (readyLines.length !== 1) {
            rejectReady(
              new Error('V2 server emitted more than one ready line'),
            );
            continue;
          }
          resolveReady(parseOrigin(readyLines[0].origin));
        }
      });
    });
    const origin = await ready;
    return { process: child, exited, origin, readyLines, stderr: () => stderr };
  }

  private async command(envelope: V2CommandEnvelope) {
    const response = await fetch(`${this.origin}/api/v2/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.origin },
      body: JSON.stringify(envelope),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return v2CommandResultSchema.parse(body);
  }

  async systemSnapshot() {
    const response = await fetch(`${this.origin}/api/v2/snapshot`);
    expect(response.status).toBe(200);
    return v2SystemSnapshotSchema.parse(await response.json());
  }

  async projectSnapshot() {
    const response = await fetch(
      `${this.origin}/api/v2/projects/${this.projectId}/snapshot`,
    );
    expect(response.status).toBe(200);
    return v2ProjectSnapshotSchema.parse(await response.json());
  }

  async waitForBrowserRegistration() {
    await expect
      .poll(async () => {
        const snapshot = await this.systemSnapshot();
        const project = snapshot.projects.find(
          ({ repositoryPath }) =>
            resolve(repositoryPath) === resolve(this.todoRepository),
        );
        if (project) this.projectIdValue = project.id;
        return project?.id;
      })
      .toBeTruthy();
    return this.projectId;
  }

  async approveProfilesAndStartExecution() {
    const global = await this.command({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_profile.approve_revision',
        scope: 'global',
        expectedLatestRevision: 0,
        sourceYaml: `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: foundation-worker
  displayName: Foundation worker
  scope: global
spec:
  assignmentKinds:
    - foundation-check
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred:
      - test-driven-development
    required:
      - mesh.foundation-check
  instructions: |
    Inspect the Todo repository without modifying it.
  outputSchema: mesh.dev/foundation-report/v1
`,
      },
    });
    expect(global).toMatchObject({
      ok: true,
      commandType: 'worker_profile.approve_revision',
      profileRevision: { revision: 1, scope: 'global' },
    });
    if (
      !global.ok ||
      global.commandType !== 'worker_profile.approve_revision'
    ) {
      throw new Error('Global profile approval failed');
    }
    const project = await this.command({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_profile.approve_revision',
        scope: 'project',
        projectId: this.projectId,
        expectedLatestRevision: 0,
        sourceYaml: `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-foundation-worker
  displayName: Todo foundation worker
  scope: project
extends:
  profile: global/foundation-worker
  revision: 1
spec:
  instructions: |
    Report deterministic Todo foundation activity.
`,
      },
    });
    if (
      !project.ok ||
      project.commandType !== 'worker_profile.approve_revision'
    ) {
      throw new Error('Project profile approval failed');
    }
    const started = await this.command({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.start',
        projectId: this.projectId,
        profileId: project.profileRevision.profileId,
        profileRevision: 1,
        assignment: {
          kind: 'foundation-check',
          projectId: this.projectId,
          title: 'Todo foundation check',
          instructions: 'Inspect the committed Todo fixture.',
          fakeScenario: 'todo-foundation-v1',
        },
      },
    });
    if (!started.ok || started.commandType !== 'worker_execution.start') {
      throw new Error('Todo execution start failed');
    }
    this.executionIdValue = started.execution.id;
    await expect
      .poll(async () => {
        const snapshot = await this.projectSnapshot();
        const execution = snapshot.executions.find(
          ({ id }) => id === this.executionId,
        );
        if (execution?.lastAdapterCursor === 2) this.heldSnapshot = snapshot;
        return (
          execution && {
            lifecycle: execution.lifecycle,
            cursor: execution.lastAdapterCursor,
          }
        );
      })
      .toEqual({ lifecycle: 'running', cursor: 2 });
    return this.heldSnapshot!;
  }

  async crashServer() {
    const child = this.child;
    if (!child) throw new Error('V2 server is not running');
    await terminateExactChild(child, 'SIGKILL');
    this.child = undefined;
  }

  async restartWithFreshFake() {
    const priorPid = this.serverPid;
    await this.crashServer();
    await this.start();
    expect(this.serverPid).not.toBe(priorPid);
    return this.origin;
  }

  async domainEventsAfter(after: number): Promise<RetainedDomainWindow> {
    const response = await fetch(
      `${this.origin}/api/v2/projects/${this.projectId}/events?stream=domain&after=${after}`,
    );
    expect(response.status).toBe(200);
    return retainedDomainWindowSchema.parse(await response.json());
  }

  async runtimeEventsAfter(after: number): Promise<RetainedRuntimeWindow> {
    const response = await fetch(
      `${this.origin}/api/v2/projects/${this.projectId}/events?stream=runtime&after=${after}`,
    );
    expect(response.status).toBe(200);
    return retainedRuntimeWindowSchema.parse(await response.json());
  }

  async subscribe(page: Page, cursors = { domain: 0, runtime: 0 }) {
    const raw = await page.evaluate(
      ({ type, projectId, protocolVersion, cursors: requestedCursors }) =>
        new Promise<unknown[]>((resolveSubscription, rejectSubscription) => {
          const socket = new WebSocket('/api/v2/realtime');
          const messages: unknown[] = [];
          socket.onerror = () =>
            rejectSubscription(new Error('V2 WebSocket failed'));
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                type,
                protocolVersion,
                projectId,
                cursors: requestedCursors,
              }),
            );
          socket.onmessage = ({ data }) => {
            const message = JSON.parse(String(data)) as { type?: string };
            messages.push(message);
            if (message.type === 'v2.subscribed') {
              socket.close();
              resolveSubscription(messages);
            }
          };
        }),
      {
        type: 'v2.subscribe',
        projectId: this.projectId,
        protocolVersion: V2_PROTOCOL_VERSION,
        cursors,
      } satisfies ClientRealtimeMessage,
    );
    return raw.map((message) => serverRealtimeMessageSchema.parse(message));
  }

  async expectContinuousStreamsAndStableSnapshots(page: Page) {
    const before = this.heldSnapshot;
    if (!before) throw new Error('No held snapshot was captured');
    await expect
      .poll(async () => {
        const execution = (await this.projectSnapshot()).executions.find(
          ({ id }) => id === this.executionId,
        );
        return execution?.lifecycle;
      })
      .toBe('completed');
    const after = await this.projectSnapshot();
    const priorExecution = before.executions.find(
      ({ id }) => id === this.executionId,
    )!;
    const execution = after.executions.find(
      ({ id }) => id === this.executionId,
    )!;
    expect(after.project).toEqual(before.project);
    expect(execution.id).toBe(priorExecution.id);
    expect(execution.profileSnapshot).toEqual(priorExecution.profileSnapshot);
    expect(execution.resolvedSkills).toEqual(priorExecution.resolvedSkills);
    expect(execution).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 6,
    });

    const runtime = await this.runtimeEventsAfter(0);
    expect(runtime.events.map(({ sequence }) => sequence)).toEqual(
      Array.from(
        { length: runtime.highWater - runtime.lowWater + 1 },
        (_, index) => runtime.lowWater + index,
      ),
    );
    const completions = runtime.events.filter(
      (event) =>
        event.executionId === this.executionId &&
        event.type === 'worker_execution.completed',
    );
    expect(completions).toEqual([
      expect.objectContaining({
        adapterCursor: 6,
        payload: { outcome: 'completed' },
      }),
    ]);

    const domain = await this.domainEventsAfter(0);
    expect(domain.events.map(({ sequence }) => sequence)).toEqual(
      Array.from(
        { length: domain.highWater - domain.lowWater + 1 },
        (_, index) => domain.lowWater + index,
      ),
    );
    expect(
      domain.events.filter(
        (event) =>
          event.type === 'worker_execution.lifecycle_changed' &&
          event.payload.execution.id === this.executionId &&
          event.payload.execution.lifecycle === 'completed',
      ),
    ).toHaveLength(1);

    const socket = await this.subscribe(page, after.cursors);
    expect(socket).toContainEqual(
      expect.objectContaining({
        type: 'v2.subscribed',
        projectId: this.projectId,
        cursors: after.cursors,
      }),
    );
    return after;
  }

  async startRequiredUnavailable() {
    const approved = await this.command({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_profile.approve_revision',
        scope: 'project',
        projectId: this.projectId,
        expectedLatestRevision: 1,
        sourceYaml: `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-foundation-worker
  displayName: Todo foundation worker
  scope: project
extends:
  profile: global/foundation-worker
  revision: 1
spec:
  skills:
    preferred:
      - test-driven-development
    required:
      - unavailable-required-skill
`,
      },
    });
    if (
      !approved.ok ||
      approved.commandType !== 'worker_profile.approve_revision'
    ) {
      throw new Error('Required-unavailable profile approval failed');
    }
    return this.command({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.start',
        projectId: this.projectId,
        profileId: approved.profileRevision.profileId,
        profileRevision: 2,
        assignment: {
          kind: 'foundation-check',
          projectId: this.projectId,
          title: 'Required skill unavailable check',
          instructions: 'Fail closed before starting the fake harness.',
          fakeScenario: 'todo-foundation-v1',
        },
      },
    });
  }

  async expectDatabaseMismatchIsNonMutating() {
    const unmarkedSource = assertContainedPath(
      this.fixtureRoot,
      join(this.fixtureRoot, 'unmarked-source.sqlite'),
    );
    const rejectedCopy = assertContainedPath(
      this.fixtureRoot,
      join(this.fixtureRoot, 'unmarked-rejected.sqlite'),
    );
    await copyFile(this.databasePath, unmarkedSource);
    const database = new Database(unmarkedSource);
    database.pragma('application_id = 0');
    database.close();
    await copyFile(unmarkedSource, rejectedCopy);
    const before = await hashFile(rejectedCopy);

    const environment: NodeJS.ProcessEnv = {
      ...minimalSystemEnvironment(),
      NODE_ENV: 'test',
      MESH_V2_PORT: '0',
      MESH_V2_WORKSPACE_ROOT: this.fixtureRoot,
      MESH_V2_DATABASE_PATH: rejectedCopy,
      MESH_V2_WEB_ROOT: webRoot,
      HOME: this.fixtureRoot,
      USERPROFILE: this.fixtureRoot,
    };
    const child = spawn(process.execPath, [serverMain], {
      cwd: workspaceRoot,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exit = await childExit(child);
    expect(exit.code).not.toBe(0);
    expect(stdout).not.toContain('mesh.v2.ready');
    expect(stderr).toContain(
      'Refusing to open non-V2 database with SQLite application ID 0',
    );
    expect(await hashFile(rejectedCopy)).toBe(before);
    return { hash: before, exit, stderr, pid: child.pid };
  }

  async dispose() {
    if (this.child) {
      await terminateExactChild(this.child, 'SIGTERM');
      this.child = undefined;
    }
    const root = resolve(this.fixtureRoot);
    const temp = resolve(tmpdir());
    const relation = relative(temp, root);
    if (
      !relation ||
      relation.startsWith('..') ||
      resolve(temp, relation) !== root
    ) {
      throw new Error(`Refusing to remove unowned fixture root: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
}
