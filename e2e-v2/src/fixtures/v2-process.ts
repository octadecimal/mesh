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
type TerminalState = {
  code: number | null;
  signal: NodeJS.Signals | null;
};
type RunningChild = {
  process: ChildProcess;
  error: Promise<Error>;
  exited: Promise<TerminalState>;
  closed: Promise<TerminalState>;
  closeState?: TerminalState;
  closing?: Promise<void>;
  detachers: Array<() => void>;
  release: () => void;
  signalExact: (signal: NodeJS.Signals) => boolean;
  origin?: string;
  readyLines: ReadyLine[];
  stderr: () => string;
};

type SpawnServerOptions = {
  holdAfterAdapterCursor?: number;
  readinessTimeoutMs?: number;
  readinessProbe?:
    | 'invalid-origin'
    | 'timeout'
    | 'blocked-sigterm'
    | 'duplicate-ready'
    | 'delayed-duplicate-ready';
  blockSigterm?: boolean;
  ignoreClose?: boolean;
  throwSignal?: NodeJS.Signals;
  onOwned?: (child: RunningChild) => void;
  onDelayedReadyEmitter?: (emit: () => void) => void;
  onReadyObserved?: (ready: ReadyLine) => void;
  onSignal?: (signal: NodeJS.Signals) => void;
};

const workspaceRoot = resolve(__dirname, '..', '..', '..');
const serverMain = join(workspaceRoot, 'dist', 'apps', 'v2-server', 'main.js');
const webRoot = join(workspaceRoot, 'dist', 'apps', 'v2-web');
const fixturePrefix = 'mesh-v2-e2e-';
const readinessTimeoutMs = 15_000;
const probeReadinessTimeoutMs = 3_000;
const gracefulCloseMs = 250;
const forcedCloseMs = 1_000;

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

const deferred = <T>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
};

const observeChild = (
  child: ChildProcess,
  options: {
    blockSigterm?: boolean;
    ignoreClose?: boolean;
    onSignal?: (signal: NodeJS.Signals) => void;
    release: () => void;
    throwSignal?: NodeJS.Signals;
  },
) => {
  const error = deferred<Error>();
  const exited = deferred<TerminalState>();
  const closed = deferred<TerminalState>();
  const detachers: Array<() => void> = [];
  const owned: RunningChild = {
    process: child,
    error: error.promise,
    exited: exited.promise,
    closed: closed.promise,
    detachers,
    release: options.release,
    signalExact: (signal) => {
      options.onSignal?.(signal);
      if (options.throwSignal === signal) {
        throw new Error(`Injected ${signal} delivery failure`);
      }
      if (options.blockSigterm && signal === 'SIGTERM') return true;
      return child.kill(signal);
    },
    readyLines: [],
    stderr: () => '',
  };
  const onError = (value: Error) => error.resolve(value);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
    exited.resolve({ code, signal });
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (options.ignoreClose) return;
    owned.closeState = { code, signal };
    closed.resolve(owned.closeState);
  };
  child.on('error', onError);
  child.on('exit', onExit);
  child.on('close', onClose);
  detachers.push(
    () => child.off('error', onError),
    () => child.off('exit', onExit),
    () => child.off('close', onClose),
  );
  return owned;
};

const settlesWithin = async (promise: Promise<unknown>, timeoutMs: number) =>
  new Promise<boolean>((resolveSettled) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettled(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });

const assertOwnedFixtureRoot = (candidate: string) => {
  const root = resolve(candidate);
  const temp = resolve(tmpdir());
  const relation = relative(temp, root);
  if (
    !relation.startsWith(fixturePrefix) ||
    relation.length === fixturePrefix.length ||
    relation.includes('/') ||
    relation.includes('\\') ||
    resolve(temp, relation) !== root
  ) {
    throw new Error(`Refusing unowned fixture root: ${root}`);
  }
  return root;
};

const closeExactChild = (
  child: RunningChild,
  options: { force?: boolean } = {},
) => {
  if (child.closing) return child.closing;
  child.closing = (async () => {
    let failure: Error | undefined;
    try {
      if (!child.closeState) {
        if (!child.process.pid) {
          if (!(await settlesWithin(child.closed, forcedCloseMs))) {
            failure = new Error('PID-less V2 child did not close');
          }
        } else {
          if (!options.force) {
            try {
              child.signalExact('SIGTERM');
            } catch {
              // Continue to the exact-child SIGKILL fallback.
            }
          }
          const gracefullyClosed =
            !options.force &&
            (await settlesWithin(child.closed, gracefulCloseMs));
          if (!gracefullyClosed && !child.closeState) {
            try {
              child.signalExact('SIGKILL');
            } catch {
              // The bounded terminal wait below remains authoritative.
            }
            if (!(await settlesWithin(child.closed, forcedCloseMs))) {
              failure = new Error(
                `Owned V2 server PID ${String(child.process.pid)} did not close after SIGKILL`,
              );
            }
          }
        }
      }
    } finally {
      try {
        child.release();
      } catch {
        // Listener cleanup remains mandatory even if ownership release fails.
      }
      for (const detach of child.detachers.splice(0)) {
        try {
          detach();
        } catch {
          // Detaching the remaining owned listeners still takes priority.
        }
      }
    }
    if (failure) throw failure;
  })();
  return child.closing;
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

  static async createTodo(options: { onRoot?: (root: string) => void } = {}) {
    let root: string | undefined;
    try {
      root = assertOwnedFixtureRoot(
        await mkdtemp(join(resolve(tmpdir()), fixturePrefix)),
      );
      options.onRoot?.(root);
      const repository = await createTodoRepository(root);
      return new V2ProcessFixture(root, repository);
    } catch (error) {
      if (root) await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  get origin() {
    if (!this.child?.origin) throw new Error('V2 server is not ready');
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
    await this.spawnServer(this.databasePath, options);
    return this.origin;
  }

  private async spawnServer(
    databasePath: string,
    options: SpawnServerOptions = {},
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
    if (options.holdAfterAdapterCursor !== undefined) {
      environment.MESH_V2_FAKE_HOLD_AFTER_CURSOR = String(
        options.holdAfterAdapterCursor,
      );
    }
    const child = spawn(process.execPath, [serverMain], {
      cwd: workspaceRoot,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const owned = observeChild(child, {
      blockSigterm: options.blockSigterm,
      ignoreClose: options.ignoreClose,
      onSignal: options.onSignal,
      release: () => {
        if (this.child === owned) this.child = undefined;
      },
      throwSignal: options.throwSignal,
    });
    this.child = owned;
    options.onOwned?.(owned);
    let stdoutBuffer = '';
    let stderr = '';
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    child.stderr?.on('data', onStderr);
    owned.detachers.push(() => child.stderr?.off('data', onStderr));
    owned.stderr = () => stderr;
    let readySettled = false;
    let resolveReady!: (origin: string) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<string>((resolveValue, rejectValue) => {
      resolveReady = resolveValue;
      rejectReady = rejectValue;
    });
    const rejectProtocol = (error: Error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
        return;
      }
      void closeExactChild(owned).catch(() => undefined);
    };
    let delayedEmitterRegistered = false;
    const onStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      const batch: ReadyLine[] = [];
      for (const line of lines) {
        if (!line) continue;
        let candidate: unknown;
        try {
          candidate = JSON.parse(line);
        } catch {
          rejectProtocol(new Error(`Unexpected V2 server stdout: ${line}`));
          return;
        }
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          (candidate as { type?: unknown }).type !== 'mesh.v2.ready' ||
          typeof (candidate as { origin?: unknown }).origin !== 'string'
        ) {
          rejectProtocol(new Error(`Unexpected V2 server stdout: ${line}`));
          return;
        }
        batch.push(candidate as ReadyLine);
      }
      if (batch.length === 0) return;
      if (
        options.readinessProbe === 'delayed-duplicate-ready' &&
        !delayedEmitterRegistered
      ) {
        delayedEmitterRegistered = true;
        const duplicate = Buffer.from(`${JSON.stringify(batch[0])}\n`);
        options.onDelayedReadyEmitter?.(() => onStdout(duplicate));
      }
      for (const observed of batch) options.onReadyObserved?.(observed);
      if (options.readinessProbe === 'duplicate-ready' && batch.length > 0) {
        batch.push(...batch);
      }
      if (
        options.readinessProbe === 'timeout' ||
        options.readinessProbe === 'blocked-sigterm'
      ) {
        return;
      }
      const accepted = batch.map((observed) =>
        options.readinessProbe === 'invalid-origin'
          ? {
              ...observed,
              origin: observed.origin.replace('127.0.0.1', 'localhost'),
            }
          : observed,
      );
      if (owned.readyLines.length + accepted.length !== 1) {
        rejectProtocol(new Error('V2 server emitted more than one ready line'));
        return;
      }
      owned.readyLines.push(...accepted);
      try {
        const origin = parseOrigin(owned.readyLines[0].origin);
        if (!readySettled) {
          readySettled = true;
          resolveReady(origin);
        }
      } catch (error) {
        rejectProtocol(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    child.stdout?.on('data', onStdout);
    owned.detachers.push(() => child.stdout?.off('data', onStdout));
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (!child.pid) throw new Error('Spawned V2 server has no PID');
      const deadline = new Promise<never>((_, rejectDeadline) => {
        timeout = setTimeout(
          () =>
            rejectDeadline(
              new Error(
                `V2 server PID ${String(child.pid)} did not become ready within ${String(options.readinessTimeoutMs ?? readinessTimeoutMs)}ms`,
              ),
            ),
          options.readinessTimeoutMs ?? readinessTimeoutMs,
        );
      });
      owned.origin = await Promise.race([
        ready,
        owned.error.then((error) => {
          throw error;
        }),
        owned.exited.then(({ code, signal }) => {
          throw new Error(
            `V2 server exited before ready (${String(code)}/${String(signal)}): ${stderr}`,
          );
        }),
        owned.closed.then(({ code, signal }) => {
          throw new Error(
            `V2 server closed before ready (${String(code)}/${String(signal)}): ${stderr}`,
          );
        }),
        deadline,
      ]);
      return owned.origin;
    } catch (error) {
      try {
        await closeExactChild(owned);
      } catch (cleanupError) {
        throw new Error(
          `V2 server startup failed (${String(error)}) and exact-child cleanup failed (${String(cleanupError)})`,
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async probeRejectedReadinessCleanup(
    mode: 'invalid-origin' | 'timeout' | 'blocked-sigterm' | 'duplicate-ready',
  ) {
    const startedAt = Date.now();
    let observedChild: RunningChild | undefined;
    let origin: string | undefined;
    const signals: NodeJS.Signals[] = [];
    await expect(
      this.spawnServer(this.databasePath, {
        readinessTimeoutMs: probeReadinessTimeoutMs,
        readinessProbe: mode,
        blockSigterm: mode === 'blocked-sigterm',
        onOwned: (child) => {
          observedChild = child;
        },
        onReadyObserved: (ready) => {
          origin = ready.origin;
        },
        onSignal: (signal) => signals.push(signal),
      }),
    ).rejects.toThrow(
      mode === 'invalid-origin'
        ? 'invalid loopback origin'
        : mode === 'duplicate-ready'
          ? 'more than one ready line'
          : `within ${String(probeReadinessTimeoutMs)}ms`,
    );
    expect(this.child).toBeUndefined();
    if (!observedChild?.process.pid || !origin)
      throw new Error(`No ${mode} cleanup evidence`);
    if (mode === 'blocked-sigterm') {
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    }
    return {
      pid: observedChild.process.pid,
      origin,
      elapsedMs: Date.now() - startedAt,
      namedListenerCount: observedChild.detachers.length,
    };
  }

  async probeEarlyExitCleanup() {
    const startedAt = Date.now();
    const databasePath = assertContainedPath(
      this.fixtureRoot,
      join(this.fixtureRoot, 'partial-start.sqlite'),
    );
    const database = new Database(databasePath);
    database.exec('CREATE TABLE partial_start_marker (value TEXT NOT NULL)');
    database.close();
    let observedChild: RunningChild | undefined;
    await expect(
      this.spawnServer(databasePath, {
        readinessTimeoutMs: probeReadinessTimeoutMs,
        onOwned: (child) => {
          observedChild = child;
        },
      }),
    ).rejects.toThrow(/exited before ready|closed before ready/u);
    expect(this.child).toBeUndefined();
    if (!observedChild?.process.pid)
      throw new Error('No early-exit cleanup evidence');
    return {
      pid: observedChild.process.pid,
      elapsedMs: Date.now() - startedAt,
      namedListenerCount: observedChild.detachers.length,
    };
  }

  async probeCloseControlCleanup() {
    const partialStartedAt = Date.now();
    const partialSignals: NodeJS.Signals[] = [];
    const missingExecutable = assertContainedPath(
      this.fixtureRoot,
      join(this.fixtureRoot, 'missing-v2-server-executable'),
    );
    const partialProcess = spawn(missingExecutable, [], {
      cwd: this.fixtureRoot,
      env: minimalSystemEnvironment(),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const partialChild = observeChild(partialProcess, {
      onSignal: (signal) => partialSignals.push(signal),
      release: () => {
        if (this.child === partialChild) this.child = undefined;
      },
    });
    this.child = partialChild;
    expect(await settlesWithin(partialChild.error, forcedCloseMs)).toBe(true);
    await closeExactChild(partialChild);
    const partialElapsedMs = Date.now() - partialStartedAt;

    let terminalChild: RunningChild | undefined;
    const terminalSignals: NodeJS.Signals[] = [];
    const origin = await this.spawnServer(this.databasePath, {
      ignoreClose: true,
      throwSignal: 'SIGTERM',
      onOwned: (child) => {
        terminalChild = child;
      },
      onSignal: (signal) => terminalSignals.push(signal),
    });
    if (!terminalChild?.process.pid)
      throw new Error('No terminal-deadline cleanup evidence');
    const terminalStartedAt = Date.now();
    const firstClose = closeExactChild(terminalChild);
    const secondClose = closeExactChild(terminalChild);
    const closeWasShared = firstClose === secondClose;
    const results = await Promise.allSettled([firstClose, secondClose]);
    const deadlineRejected = results.every(
      (result) => result.status === 'rejected',
    );

    return {
      partialStartup: {
        pid: partialProcess.pid ?? null,
        signals: partialSignals,
        ownershipReleased: this.child !== partialChild,
        elapsedMs: partialElapsedMs,
        namedListenerCount: partialChild.detachers.length,
      },
      terminalDeadline: {
        pid: terminalChild.process.pid,
        origin,
        signals: terminalSignals,
        closeWasShared,
        deadlineRejected,
        ownershipReleased: this.child !== terminalChild,
        elapsedMs: Date.now() - terminalStartedAt,
        namedListenerCount: terminalChild.detachers.length,
      },
    };
  }

  async probeDelayedDuplicateReadyCleanup() {
    let emitDuplicate: (() => void) | undefined;
    let observedChild: RunningChild | undefined;
    const origin = await this.spawnServer(this.databasePath, {
      readinessProbe: 'delayed-duplicate-ready',
      onDelayedReadyEmitter: (emit) => {
        emitDuplicate = emit;
      },
      onOwned: (child) => {
        observedChild = child;
      },
    });
    if (!emitDuplicate || !observedChild?.process.pid)
      throw new Error('No delayed-ready cleanup evidence');
    const startedAt = Date.now();
    emitDuplicate();
    if (!observedChild.closing)
      throw new Error('Delayed ready did not trigger the running guard');
    await observedChild.closing;
    expect(this.child).toBeUndefined();
    return {
      pid: observedChild.process.pid,
      origin,
      elapsedMs: Date.now() - startedAt,
      namedListenerCount: observedChild.detachers.length,
    };
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
    expect(child.readyLines).toHaveLength(1);
    await closeExactChild(child, { force: true });
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
    expect(
      runtime.events.filter(
        (event) =>
          event.executionId === this.executionId &&
          event.type === 'worker_execution.child_finished',
      ),
    ).toEqual([expect.objectContaining({ adapterCursor: 4 })]);

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

    const result = await this.runMismatchProbe(rejectedCopy);
    expect(result.exit.code).not.toBe(0);
    expect(result.stdout).not.toContain('mesh.v2.ready');
    expect(result.stderr).toContain(
      'Refusing to open non-V2 database with SQLite application ID 0',
    );
    expect(await hashFile(rejectedCopy)).toBe(before);
    return { hash: before, ...result };
  }

  private async runMismatchProbe(
    databasePath: string,
    options: {
      blockSigterm?: boolean;
      onOwned?: (child: RunningChild) => void;
      onReady?: (ready: ReadyLine) => void;
      onSignal?: (signal: NodeJS.Signals) => void;
    } = {},
  ) {
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
    const child = spawn(process.execPath, [serverMain], {
      cwd: workspaceRoot,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const owned = observeChild(child, {
      blockSigterm: options.blockSigterm,
      onSignal: options.onSignal,
      release: () => undefined,
    });
    options.onOwned?.(owned);
    let stdout = '';
    let stderr = '';
    owned.stderr = () => stderr;
    let stdoutBuffer = '';
    let rejectUnexpectedReady: (error: Error) => void = () => undefined;
    const unexpectedReady = new Promise<never>((_, reject) => {
      rejectUnexpectedReady = reject;
    });
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const candidate = JSON.parse(line) as Partial<ReadyLine>;
          if (
            candidate.type === 'mesh.v2.ready' &&
            typeof candidate.origin === 'string'
          ) {
            const ready = {
              type: candidate.type,
              origin: parseOrigin(candidate.origin),
            } satisfies ReadyLine;
            owned.readyLines.push(ready);
            owned.origin = ready.origin;
            options.onReady?.(ready);
            rejectUnexpectedReady(
              new Error(
                `Database mismatch probe unexpectedly became ready at ${ready.origin}`,
              ),
            );
          }
        } catch (error) {
          rejectUnexpectedReady(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    owned.detachers.push(
      () => child.stdout?.off('data', onStdout),
      () => child.stderr?.off('data', onStderr),
    );
    let timer: NodeJS.Timeout | undefined;
    let exit: TerminalState | undefined;
    try {
      if (!child.pid) throw new Error('Spawned mismatch probe has no PID');
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () =>
            rejectTimeout(
              new Error(
                `Database mismatch probe PID ${String(child.pid)} did not exit within ${String(readinessTimeoutMs)}ms`,
              ),
            ),
          readinessTimeoutMs,
        );
      });
      exit = await Promise.race([
        owned.exited,
        owned.error.then((error) => {
          throw error;
        }),
        unexpectedReady,
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await closeExactChild(owned);
    }
    if (!exit) throw new Error('Database mismatch probe produced no exit');
    return { exit, stdout, stderr, pid: child.pid };
  }

  async probeUnexpectedMismatchReadyCleanup(blockSigterm = false) {
    const startedAt = Date.now();
    let observed: ReadyLine | undefined;
    let observedChild: RunningChild | undefined;
    const signals: NodeJS.Signals[] = [];
    let rejected = false;
    try {
      await this.runMismatchProbe(this.databasePath, {
        blockSigterm,
        onOwned: (child) => {
          observedChild = child;
        },
        onReady: (ready) => {
          observed = ready;
        },
        onSignal: (signal) => signals.push(signal),
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('unexpectedly became ready');
    }
    expect(rejected).toBe(true);
    if (!observed || !observedChild?.process.pid)
      throw new Error('Mismatch cleanup emitted incomplete ready evidence');
    if (blockSigterm) expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    const ready = observed as ReadyLine;
    return {
      pid: observedChild.process.pid,
      origin: ready.origin,
      elapsedMs: Date.now() - startedAt,
      namedListenerCount: observedChild.detachers.length,
    };
  }

  async dispose() {
    if (this.child) {
      await closeExactChild(this.child);
    }
    const root = assertOwnedFixtureRoot(this.fixtureRoot);
    await rm(root, { recursive: true, force: true });
  }
}
