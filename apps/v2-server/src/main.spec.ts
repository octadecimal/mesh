import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import {
  DEVELOPER_REPORT_SCHEMA,
  PM_DISCOVERY_REPORT_SCHEMA,
  V2_PROTOCOL_VERSION,
  developerAttemptSchema,
  developerTaskAssignmentSchema,
  serverRealtimeMessageSchema,
  startExecutionEnvelopeSchema,
  v2CommandResultSchema,
  v2ProjectSnapshotSchema,
  workerProfileRevisionSchema,
  type HarnessAdapter,
  type PlanningCycle,
  type PlanningTurn,
  type ResolvedWorkerProfileSnapshot,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FakeHarnessAdapter } from './executions/fake-harness';
import { AuditBarrier } from './executions/audit-barrier';
import { ExecutionRepository } from './executions/execution-repository';
import { ExecutionRuntime } from './executions/execution-runtime';
import { OperationRepository } from './executions/operation-repository';
import { DeveloperRepository } from './developer/developer-repository';
import { deriveManagedWorkspace } from './developer/managed-workspace';
import { startV2Server, type RunningV2Server } from './main';
import { PlanningRepository } from './planning/planning-repository';
import { approveV2GitExecutable } from './platform/process-runner';
import { canonicalJson } from './storage/canonical-json';
import {
  hashV2Command,
  V2CommandRepository,
} from './storage/command-repository';
import { approveTestDeliveryPlan } from './test/approved-delivery-plan';
import { createV2TestDatabase } from './test/create-v2-test-database';
import { inImmediateTransaction, openV2Database } from './db/database';
import { V2EventStore } from './storage/event-store';

const servers: RunningV2Server[] = [];
const directories: string[] = [];
const workspaceRoot = resolve(__dirname, '..', '..', '..');
const localRequire = createRequire(__filename);
let builtRoot: string | undefined;
let builtMain: string | undefined;
let builtSignalBridge: string | undefined;
let builtWebRoot: string | undefined;

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

type PlanningRecoveryCase =
  | 'bound_output'
  | 'bound_terminal'
  | 'unbound_terminal'
  | 'pending_without_operation'
  | 'ambiguous_before_start'
  | 'ambiguous_after_start';

const seedPlanningRecoveryCase = async (kind: PlanningRecoveryCase) => {
  const fixture = createV2TestDatabase();
  const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
  let adapter: HarnessAdapter = fake;
  if (kind === 'unbound_terminal') {
    const capabilities = await fake.capabilities();
    adapter = {
      id: fake.id,
      capabilities: async () => ({ ...capabilities, capabilities: [] }),
      resolveSkills: (requests) => fake.resolveSkills(requests),
      start: (request) => fake.start(request),
      probe: (nativeHandle) => fake.probe(nativeHandle),
      resume: (request) => fake.resume(request),
      interrupt: (nativeHandle) => fake.interrupt(nativeHandle),
    };
  }
  const planning = new PlanningRepository(fixture.database);
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  const cycleId = randomUUID();
  const turnId = randomUUID();
  const now = '2026-08-29T00:00:00.000Z';
  const cycle: PlanningCycle = {
    id: cycleId,
    projectId: fixture.project.id,
    lifecycle: 'launch_pending',
    revision: 0,
    profileId: fixture.pmProfileRevision.profileId,
    profileRevision: fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const turn: PlanningTurn = {
    id: turnId,
    projectId: fixture.project.id,
    planningCycleId: cycleId,
    ordinal: 1,
    actor: 'human',
    message: 'Build a durable Todo application.',
    launchState: 'launch_pending',
    executionId: null,
    createdAt: now,
  };
  inImmediateTransaction(fixture.database, () => {
    planning.insertCycleInTransaction(cycle);
    planning.insertTurnInTransaction(turn);
  });
  const profile: ResolvedWorkerProfileSnapshot = {
    profileId: fixture.pmProfileRevision.profileId,
    projectId: fixture.pmProfileRevision.projectId,
    profileRevision: fixture.pmProfileRevision.revision,
    baseProfileId: fixture.pmProfileRevision.baseProfileId,
    baseRevision: fixture.pmProfileRevision.baseRevision,
    document: fixture.pmProfileRevision.document,
    digest: fixture.pmProfileRevision.digest,
  };
  const runtime = new ExecutionRuntime({
    database: fixture.database,
    commands: fixture.commands,
    events: fixture.events,
    projects: {
      get: (projectId) =>
        projectId === fixture.project.id ? fixture.project : undefined,
    },
    profiles: { resolveApproved: () => profile },
    executions,
    operations,
    adapter,
    publisher: { domain: () => undefined, runtime: () => undefined },
    barrier: new AuditBarrier(),
    now: () => now,
  });
  const launch = startExecutionEnvelopeSchema.parse({
    idempotencyKey: `planning-turn:${turnId}`,
    actor: { kind: 'human' },
    command: {
      type: 'worker_execution.start',
      projectId: fixture.project.id,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      assignment: {
        kind: 'pm_discovery',
        projectId: fixture.project.id,
        outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId: cycleId,
        humanTurnId: turnId,
        expectedCycleRevision: 0,
        expectedProposalRevision: 1,
        baseProjectIntentRevision: null,
        baseLedgerRevision: null,
        input: {
          conversation: [{ turnId, actor: 'human', message: turn.message }],
          latestProposal: null,
          approvedIntentLedger: null,
        },
      },
    },
  });
  let executionId: string | undefined;
  let operationId: string | undefined;
  if (kind !== 'pending_without_operation') {
    const reservation = await runtime.reserveStart(launch);
    executionId = reservation.execution.id;
    operationId = operations
      .listForExecution(reservation.execution.id)
      .find(({ kind: operationKind }) => operationKind === 'start')?.id;
    if (kind !== 'unbound_terminal') {
      inImmediateTransaction(fixture.database, () => {
        planning.bindTurnInTransaction(turnId, reservation.execution.id);
        planning.updateCycleInTransaction(
          {
            ...cycle,
            lifecycle: 'execution_active',
            activeExecutionId: reservation.execution.id,
          },
          cycle.revision,
        );
      });
    }
    if (kind === 'bound_output') {
      await runtime.activateReserved(reservation.execution.id);
      await runtime.drain();
    } else if (kind === 'bound_terminal') {
      await runtime.cancelReserved(reservation.execution.id);
    } else if (kind === 'ambiguous_after_start') {
      await adapter.start({
        executionId: reservation.execution.id,
        project: fixture.project,
        assignment: reservation.execution.assignment,
        profile: reservation.execution.profileSnapshot,
        resolvedSkills: reservation.execution.resolvedSkills,
      });
    }
  }
  return {
    fixture,
    fake,
    adapter,
    cycleId,
    executionId,
    operationId,
    startCount: fake.startCount,
    resumeCount: fake.resumeCount,
  };
};

type DeveloperStartRecoveryCase =
  | 'reserved_before_git'
  | 'reserved_after_git'
  | 'reserved_branch_collision'
  | 'provisioning'
  | 'provisioning_missing'
  | 'provisioning_dirty'
  | 'provisioning_wrong_ownership'
  | 'unclaimed';

const seedDeveloperStartRecoveryCase = async (
  kind: DeveloperStartRecoveryCase,
) => {
  const fixture = createV2TestDatabase();
  const root = temporaryDirectory();
  const repositoryPath = join(root, 'repository');
  const git = await approveV2GitExecutable({
    pathValue: process.env.PATH ?? process.env.Path,
    workspaceRoot: root,
  });
  mkdirSync(repositoryPath);
  execFileSync(git.path, ['init', repositoryPath], { shell: false });
  execFileSync(
    git.path,
    ['-C', repositoryPath, 'config', 'user.email', 'test@mesh.local'],
    { shell: false },
  );
  execFileSync(
    git.path,
    ['-C', repositoryPath, 'config', 'user.name', 'Mesh test'],
    { shell: false },
  );
  writeFileSync(join(repositoryPath, 'README.md'), 'test\n');
  execFileSync(git.path, ['-C', repositoryPath, 'add', 'README.md'], {
    shell: false,
  });
  execFileSync(git.path, ['-C', repositoryPath, 'commit', '-m', 'fixture'], {
    shell: false,
  });
  const headCommit = execFileSync(
    git.path,
    ['-C', repositoryPath, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', shell: false },
  ).trim();
  const commonDirectory = join(repositoryPath, '.git');
  const repositoryIdentity =
    process.platform === 'win32'
      ? commonDirectory.toLowerCase()
      : commonDirectory;
  fixture.database
    .prepare(
      `UPDATE projects SET repository_path = ?, git_common_directory = ?,
         repository_identity = ?, head_commit = ? WHERE id = ?`,
    )
    .run(
      repositoryPath,
      commonDirectory,
      repositoryIdentity,
      headCommit,
      fixture.project.id,
    );
  const developerProfile = workerProfileRevisionSchema.parse({
    ...fixture.profileRevision,
    name: 'developer-worker',
    displayName: 'Developer worker',
    document: {
      ...fixture.profileRevision.document,
      metadata: {
        ...fixture.profileRevision.document.metadata,
        name: 'developer-worker',
        displayName: 'Developer worker',
      },
      spec: {
        ...fixture.profileRevision.document.spec,
        assignmentKinds: ['developer_task'],
        outputSchema: DEVELOPER_REPORT_SCHEMA,
      },
    },
  });
  fixture.database
    .prepare(
      `UPDATE worker_profiles SET name = ?, display_name = ? WHERE id = ?`,
    )
    .run(
      developerProfile.name,
      developerProfile.displayName,
      developerProfile.profileId,
    );
  fixture.database
    .prepare(
      `UPDATE worker_profile_revisions SET normalized_json = ?
       WHERE profile_id = ? AND revision = ?`,
    )
    .run(
      canonicalJson(developerProfile.document),
      developerProfile.profileId,
      developerProfile.revision,
    );
  const planning = new PlanningRepository(fixture.database);
  const seeded = approveTestDeliveryPlan(fixture, planning);
  const authority = planning.taskExecutionAuthority(
    fixture.project.id,
    seeded.taskId,
  );
  if (!authority) throw new Error('Developer task authority was not seeded');
  const attemptId = developerAttemptSchema.shape.id.parse(randomUUID());
  const createdAt = '2026-09-01T12:00:00.000Z';
  const workspace = deriveManagedWorkspace({
    managedRoot: join(dirname(fixture.path), 'developer-worktrees'),
    projectId: authority.project.id,
    taskId: authority.task.id,
    attemptId,
    repositoryPath,
    repositoryIdentity,
    baseCommit: headCommit,
    createdAt,
  });
  const assignment = developerTaskAssignmentSchema.parse({
    kind: 'developer_task',
    projectId: authority.project.id,
    attemptId,
    taskId: authority.task.id,
    taskContractRevision: authority.task.contractRevision,
    taskCurrentRevision: authority.task.revision,
    deliveryPlanId: authority.deliveryPlan.plan.id,
    deliveryPlanRevision: authority.deliveryPlan.plan.revision,
    requirementRevisions: authority.requirementRevisions,
    baseCommit: headCommit,
    workspacePath: workspace.path,
    title: authority.task.title,
    outcome: authority.task.outcome,
    acceptanceCriteria: authority.task.acceptanceCriteria,
    verification: authority.task.verificationCriteria,
    expectedArtifacts: authority.task.expectedArtifacts,
    outputSchema: DEVELOPER_REPORT_SCHEMA,
  });
  const attempt = developerAttemptSchema.parse({
    id: attemptId,
    projectId: authority.project.id,
    taskId: authority.task.id,
    ordinal: 1,
    lifecycle: 'reserved',
    revision: 0,
    deliveryPlanId: authority.deliveryPlan.plan.id,
    deliveryPlanRevision: authority.deliveryPlan.plan.revision,
    intentRevision: authority.intentRevision,
    ledgerRevision: authority.ledgerRevision,
    taskContractRevision: authority.task.contractRevision,
    taskCurrentRevision: authority.task.revision,
    requirementRevisions: authority.requirementRevisions,
    baseCommit: headCommit,
    profileId: developerProfile.profileId,
    profileRevision: developerProfile.revision,
    assignment,
    workspace,
    controllingExecutionId: null,
    executionIds: [],
    reportIds: [],
    attention: null,
    createdAt,
    updatedAt: createdAt,
    endedAt: null,
  });
  const envelope = {
    idempotencyKey: `developer-recovery-${kind}-${randomUUID()}`,
    actor: { kind: 'human' as const },
    command: {
      type: 'developer_attempt.start' as const,
      projectId: attempt.projectId,
      taskId: attempt.taskId,
      expectedTaskRevision: attempt.taskCurrentRevision,
      expectedDeliveryPlanId: attempt.deliveryPlanId,
      expectedDeliveryPlanRevision: attempt.deliveryPlanRevision,
      profileId: attempt.profileId,
      profileRevision: attempt.profileRevision,
    },
  };
  const developers = new DeveloperRepository(fixture.database);
  inImmediateTransaction(fixture.database, () => {
    developers.reserveAttemptInTransaction(
      attempt,
      kind === 'unclaimed'
        ? undefined
        : {
            attemptId,
            projectId: attempt.projectId,
            idempotencyKey: envelope.idempotencyKey,
            commandType: envelope.command.type,
            requestHash: hashV2Command(envelope.command),
            board: authority.board,
            createdAt,
          },
    );
  });
  if (kind === 'reserved_branch_collision') {
    execFileSync(
      git.path,
      ['-C', repositoryPath, 'branch', workspace.branch, workspace.baseCommit],
      { shell: false },
    );
  }
  const hasWorkspace = [
    'reserved_after_git',
    'provisioning',
    'provisioning_dirty',
    'provisioning_wrong_ownership',
  ].includes(kind);
  let ownershipPath: string | undefined;
  if (hasWorkspace) {
    mkdirSync(dirname(workspace.path), { recursive: true });
    execFileSync(
      git.path,
      [
        '-C',
        repositoryPath,
        'worktree',
        'add',
        '-b',
        workspace.branch,
        workspace.path,
        workspace.baseCommit,
      ],
      { shell: false },
    );
    const gitDirectory = execFileSync(
      git.path,
      ['-C', workspace.path, 'rev-parse', '--git-dir'],
      { encoding: 'utf8', shell: false },
    ).trim();
    ownershipPath = resolve(workspace.path, gitDirectory, 'mesh-owner.json');
    writeFileSync(
      ownershipPath,
      `${JSON.stringify({
        schema: 'mesh.v2/developer-workspace-owner/v1',
        attemptId,
        ownershipToken: workspace.ownershipToken,
        repositoryIdentity,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
      })}\n`,
    );
  }
  if (kind.startsWith('provisioning')) {
    const ready = {
      ...workspace,
      lifecycle: 'ready' as const,
      observedHead: workspace.baseCommit,
      observedDirty: false,
      revision: 1,
      updatedAt: createdAt,
    };
    inImmediateTransaction(fixture.database, () => {
      developers.recordWorkspaceObservationInTransaction(ready, 0);
      developers.transitionAttemptInTransaction(
        {
          ...attempt,
          lifecycle: 'provisioning',
          revision: 1,
          workspace: ready,
        },
        0,
      );
    });
  }
  if (kind === 'provisioning_dirty') {
    writeFileSync(join(workspace.path, 'dirty.txt'), 'preserve\n');
  }
  if (kind === 'provisioning_wrong_ownership') {
    const ownership = JSON.parse(readFileSync(ownershipPath!, 'utf8')) as {
      ownershipToken: string;
    };
    writeFileSync(
      ownershipPath!,
      `${JSON.stringify({ ...ownership, ownershipToken: randomUUID() })}\n`,
    );
  }
  return {
    fixture,
    git,
    repositoryPath,
    workspacePath: workspace.path,
    attemptId,
    attempt,
    board: authority.board,
    envelope,
  };
};

const immediatelyResolvingResumeAdapter = (
  fake: FakeHarnessAdapter,
): HarnessAdapter => ({
  id: fake.id,
  capabilities: () => fake.capabilities(),
  resolveSkills: (requests) => fake.resolveSkills(requests),
  start: (request) => fake.start(request),
  probe: (nativeHandle) => fake.probe(nativeHandle),
  resume: async (request) => {
    const session = await fake.resume(request);
    const events: unknown[] = [];
    for await (const event of session.events(request.afterAdapterCursor)) {
      events.push(event);
    }
    let index = 0;
    return {
      get nativeHandle() {
        return session.nativeHandle;
      },
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.resolve(
              index < events.length
                ? { done: false as const, value: events[index++] }
                : { done: true as const, value: undefined },
            ),
        }),
      }),
      close: () => session.close(),
    };
  },
  interrupt: (nativeHandle) => fake.interrupt(nativeHandle),
});

const buildProductionEntrypoint = () => {
  if (builtMain && builtSignalBridge) {
    return { main: builtMain, signalBridge: builtSignalBridge };
  }
  builtRoot = mkdtempSync(join(workspaceRoot, '.mesh-v2-entrypoint-test-'));
  builtMain = join(workspaceRoot, 'dist', 'apps', 'v2-server', 'main.js');
  builtSignalBridge = join(builtRoot, 'signal-bridge.cjs');
  const buildEnvironment = { ...process.env };
  for (const name of Object.keys(buildEnvironment)) {
    if (name.startsWith('NX_')) delete buildEnvironment[name];
  }
  execFileSync(
    process.execPath,
    [
      localRequire.resolve('nx/bin/nx.js'),
      'build',
      'v2-server',
      '--configuration=production',
      '--skip-nx-cache',
    ],
    {
      cwd: workspaceRoot,
      env: { ...buildEnvironment, NX_DAEMON: 'false' },
      shell: false,
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  if (!existsSync(builtMain)) {
    throw new Error(`Nx did not create the V2 server entrypoint: ${builtMain}`);
  }
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

const buildProductionWebRoot = () => {
  if (builtWebRoot) return builtWebRoot;
  builtWebRoot = join(workspaceRoot, 'dist', 'apps', 'v2-web');
  const buildEnvironment = { ...process.env };
  for (const name of Object.keys(buildEnvironment)) {
    if (name.startsWith('NX_')) delete buildEnvironment[name];
  }
  execFileSync(
    process.execPath,
    [
      localRequire.resolve('nx/bin/nx.js'),
      'build',
      'v2-web',
      '--configuration=production',
      '--skip-nx-cache',
    ],
    {
      cwd: workspaceRoot,
      env: { ...buildEnvironment, NX_DAEMON: 'false' },
      shell: false,
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  return builtWebRoot;
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

beforeAll(() => {
  buildProductionEntrypoint();
  buildProductionWebRoot();
}, 120_000);

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

  it('wires a completed fake Developer attempt through reports, snapshots, and replay', async () => {
    const fixture = createV2TestDatabase();
    const root = temporaryDirectory();
    const repositoryPath = join(root, 'repository');
    let server: RunningV2Server | undefined;
    let workspacePath: string | undefined;
    const git = await approveV2GitExecutable({
      pathValue: process.env.PATH ?? process.env.Path,
      workspaceRoot: root,
    });
    try {
      mkdirSync(repositoryPath);
      execFileSync(git.path, ['init', repositoryPath], { shell: false });
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.email', 'test@mesh.local'],
        { shell: false },
      );
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.name', 'Mesh test'],
        { shell: false },
      );
      writeFileSync(join(repositoryPath, 'README.md'), 'test\n');
      execFileSync(git.path, ['-C', repositoryPath, 'add', 'README.md'], {
        shell: false,
      });
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'commit', '-m', 'fixture'],
        { shell: false },
      );
      const headCommit = execFileSync(
        git.path,
        ['-C', repositoryPath, 'rev-parse', 'HEAD'],
        { encoding: 'utf8', shell: false },
      ).trim();
      const commonDirectory = join(repositoryPath, '.git');
      fixture.database
        .prepare(
          `UPDATE projects SET repository_path = ?, git_common_directory = ?,
             repository_identity = ?, head_commit = ? WHERE id = ?`,
        )
        .run(
          repositoryPath,
          commonDirectory,
          process.platform === 'win32'
            ? commonDirectory.toLowerCase()
            : commonDirectory,
          headCommit,
          fixture.project.id,
        );
      const developerProfileId = randomUUID();
      const developerProfile = workerProfileRevisionSchema.parse({
        ...fixture.profileRevision,
        profileId: developerProfileId,
        name: 'developer-worker',
        displayName: 'Developer worker',
        document: {
          ...fixture.profileRevision.document,
          metadata: {
            ...fixture.profileRevision.document.metadata,
            name: 'developer-worker',
            displayName: 'Developer worker',
          },
          spec: {
            ...fixture.profileRevision.document.spec,
            assignmentKinds: ['developer_task'],
            outputSchema: DEVELOPER_REPORT_SCHEMA,
          },
        },
      });
      fixture.database
        .prepare(
          `INSERT INTO worker_profiles (
            id, scope, project_id, name, display_name, approved_revision,
            created_at, updated_at
          ) VALUES (?, 'global', NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          developerProfileId,
          developerProfile.name,
          developerProfile.displayName,
          developerProfile.approvedAt,
          developerProfile.approvedAt,
        );
      fixture.database
        .prepare(
          `INSERT INTO worker_profile_revisions (
            profile_id, revision, source_yaml, normalized_json,
            base_profile_id, base_revision, approved_by, approved_at, digest
          ) VALUES (?, 1, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          developerProfileId,
          developerProfile.sourceYaml,
          canonicalJson(developerProfile.document),
          canonicalJson(developerProfile.approvedBy),
          developerProfile.approvedAt,
          developerProfile.digest,
        );
      const planning = new PlanningRepository(fixture.database);
      const seeded = approveTestDeliveryPlan(fixture, planning);
      const authority = planning.taskExecutionAuthority(
        fixture.project.id,
        seeded.taskId,
      );
      if (!authority)
        throw new Error('Developer task authority was not seeded');
      fixture.database.close();

      let settledResolve!: () => void;
      const settled = new Promise<void>((resolveSettled) => {
        settledResolve = resolveSettled;
      });
      server = await startV2Server({
        environment: {
          ...(await environment(repositoryPath, fixture.path)),
          MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO: 'completed',
        },
        test: {
          onPublished: (message) => {
            if (
              message.type === 'v2.domain_event' &&
              message.event.type === 'developer_report.recorded'
            )
              settledResolve();
          },
        },
      });
      const start = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.start',
            projectId: fixture.project.id,
            taskId: authority.task.id,
            expectedTaskRevision: authority.task.revision,
            expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
            expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
            profileId: developerProfile.profileId,
            profileRevision: developerProfile.revision,
          },
        }),
      });
      expect(start.status).toBe(200);
      const started = v2CommandResultSchema.parse(await start.json());
      if (!started.ok || started.commandType !== 'developer_attempt.start') {
        throw new Error('Developer attempt did not start');
      }

      await settled;
      const snapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const attempt = snapshot.developerAttempts?.find(
        ({ id }) => id === started.attempt.id,
      );
      workspacePath = attempt?.workspace.path;
      expect(attempt).toMatchObject({
        lifecycle: 'completed',
        reportIds: [expect.any(String)],
        workspace: {
          path: expect.stringContaining(
            join(dirname(fixture.path), 'developer-worktrees'),
          ),
          observedDirty: true,
        },
      });
      expect(snapshot.developerReports).toMatchObject([
        {
          report: {
            disposition: 'completed',
            attemptId: started.attempt.id,
            executionId: attempt?.controllingExecutionId,
          },
        },
      ]);
      expect(readFileSync(join(workspacePath!, 'todo-m4.txt'), 'utf8')).toBe(
        'persisted\n',
      );
      expect(
        execFileSync(
          git.path,
          ['-C', workspacePath!, 'status', '--porcelain'],
          {
            encoding: 'utf8',
            shell: false,
          },
        ).trim(),
      ).toBe('?? todo-m4.txt');
      const replay = (await fetch(
        `${server.origin}/api/v2/projects/${fixture.project.id}/events?stream=domain&after=0`,
      ).then((response) => response.json())) as {
        events: Array<{ type: string }>;
      };
      expect(replay.events.map(({ type }) => type)).toEqual(
        expect.arrayContaining([
          'developer_workspace.changed',
          'developer_report.recorded',
          'developer_attempt.changed',
        ]),
      );
      const stale = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.start',
            projectId: fixture.project.id,
            taskId: authority.task.id,
            expectedTaskRevision: authority.task.revision,
            expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
            expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
            profileId: developerProfile.profileId,
            profileRevision: developerProfile.revision,
          },
        }),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: 'developer_task_stale' },
      });
    } finally {
      await server?.close();
      if (workspacePath) {
        execFileSync(
          git.path,
          [
            '-C',
            repositoryPath,
            'worktree',
            'remove',
            '--force',
            workspacePath,
          ],
          { shell: false },
        );
      }
      fixture.close();
    }
  }, 30_000);

  it('maps real Developer service failures to 400 and 503 through Fastify', async () => {
    const fixture = createV2TestDatabase();
    const root = temporaryDirectory();
    const repositoryPath = join(root, 'repository');
    const git = await approveV2GitExecutable({
      pathValue: process.env.PATH ?? process.env.Path,
      workspaceRoot: root,
    });
    let server: RunningV2Server | undefined;
    let workspacePath: string | undefined;
    try {
      mkdirSync(repositoryPath);
      execFileSync(git.path, ['init', repositoryPath], { shell: false });
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.email', 'test@mesh.local'],
        { shell: false },
      );
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.name', 'Mesh test'],
        { shell: false },
      );
      writeFileSync(join(repositoryPath, 'README.md'), '# Todo\n');
      execFileSync(git.path, ['-C', repositoryPath, 'add', '.'], {
        shell: false,
      });
      execFileSync(git.path, ['-C', repositoryPath, 'commit', '-m', 'seed'], {
        shell: false,
      });
      const headCommit = execFileSync(
        git.path,
        ['-C', repositoryPath, 'rev-parse', 'HEAD'],
        { encoding: 'utf8', shell: false },
      ).trim();
      const commonDirectory = join(repositoryPath, '.git');
      fixture.database
        .prepare(
          `UPDATE projects SET repository_path = ?, git_common_directory = ?,
             repository_identity = ?, head_commit = ? WHERE id = ?`,
        )
        .run(
          repositoryPath,
          commonDirectory,
          process.platform === 'win32'
            ? commonDirectory.toLowerCase()
            : commonDirectory,
          headCommit,
          fixture.project.id,
        );
      const developerProfileId = randomUUID();
      const developerProfile = workerProfileRevisionSchema.parse({
        ...fixture.profileRevision,
        profileId: developerProfileId,
        name: 'developer-worker',
        displayName: 'Developer worker',
        document: {
          ...fixture.profileRevision.document,
          metadata: {
            ...fixture.profileRevision.document.metadata,
            name: 'developer-worker',
            displayName: 'Developer worker',
          },
          spec: {
            ...fixture.profileRevision.document.spec,
            assignmentKinds: ['developer_task'],
            outputSchema: DEVELOPER_REPORT_SCHEMA,
          },
        },
      });
      fixture.database
        .prepare(
          `INSERT INTO worker_profiles (
            id, scope, project_id, name, display_name, approved_revision,
            created_at, updated_at
          ) VALUES (?, 'global', NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          developerProfileId,
          developerProfile.name,
          developerProfile.displayName,
          developerProfile.approvedAt,
          developerProfile.approvedAt,
        );
      fixture.database
        .prepare(
          `INSERT INTO worker_profile_revisions (
            profile_id, revision, source_yaml, normalized_json,
            base_profile_id, base_revision, approved_by, approved_at, digest
          ) VALUES (?, 1, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          developerProfileId,
          developerProfile.sourceYaml,
          canonicalJson(developerProfile.document),
          canonicalJson(developerProfile.approvedBy),
          developerProfile.approvedAt,
          developerProfile.digest,
        );
      const planning = new PlanningRepository(fixture.database);
      const seeded = approveTestDeliveryPlan(fixture, planning);
      const authority = planning.taskExecutionAuthority(
        fixture.project.id,
        seeded.taskId,
      );
      if (!authority)
        throw new Error('Developer task authority was not seeded');
      const fake = new FakeHarnessAdapter();
      const unavailableAdapter: HarnessAdapter = {
        id: fake.id,
        capabilities: async () => {
          throw new Error('Fake adapter is unavailable');
        },
        resolveSkills: (requests) => fake.resolveSkills(requests),
        start: (request) => fake.start(request),
        resume: (request) => fake.resume(request),
        probe: (nativeHandle) => fake.probe(nativeHandle),
        interrupt: (nativeHandle) => fake.interrupt(nativeHandle),
      };
      fixture.database.close();
      server = await startV2Server({
        environment: await environment(repositoryPath, fixture.path),
        test: { adapter: unavailableAdapter },
      });
      const command = (
        profileId: string,
        profileRevision: number,
        idempotencyKey = randomUUID(),
      ) => ({
        idempotencyKey,
        actor: { kind: 'human' },
        command: {
          type: 'developer_attempt.start',
          projectId: fixture.project.id,
          taskId: authority.task.id,
          expectedTaskRevision: authority.task.revision,
          expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
          expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
          profileId,
          profileRevision,
        },
      });
      const incompatible = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          command(
            fixture.profileRevision.profileId,
            fixture.profileRevision.revision,
          ),
        ),
      });
      expect(incompatible.status).toBe(400);
      expect(await incompatible.json()).toMatchObject({
        error: { code: 'developer_profile_incompatible' },
      });
      const unavailableEnvelope = command(
        developerProfile.profileId,
        developerProfile.revision,
      );
      const unavailable = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(unavailableEnvelope),
      });
      expect(unavailable.status).toBe(503);
      const unavailableBody = await unavailable.json();
      expect(unavailableBody).toMatchObject({
        error: { code: 'adapter_unavailable' },
      });
      const unavailableReplay = await fetch(
        `${server.origin}/api/v2/commands`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(unavailableEnvelope),
        },
      );
      expect(unavailableReplay.status).toBe(503);
      expect(await unavailableReplay.json()).toEqual(unavailableBody);
      const snapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      workspacePath = snapshot.developerAttempts?.[0]?.workspace.path;
      expect(snapshot.developerAttempts).toMatchObject([
        { lifecycle: 'attention_required' },
      ]);
      expect(snapshot.developerAttempts).toHaveLength(1);
      expect(
        snapshot.executions.filter(
          (execution) => execution.assignment.kind === 'developer_task',
        ),
      ).toHaveLength(0);
    } finally {
      await server?.close();
      if (workspacePath) {
        execFileSync(
          git.path,
          [
            '-C',
            repositoryPath,
            'worktree',
            'remove',
            '--force',
            workspacePath,
          ],
          { shell: false },
        );
      }
      fixture.close();
    }
  }, 30_000);

  it.each([
    ['reserved_before_git', 'active', 1, 1],
    ['reserved_after_git', 'active', 1, 0],
    ['reserved_branch_collision', 'attention_required', 0, 0],
    ['provisioning', 'active', 1, 0],
    ['provisioning_missing', 'attention_required', 0, 0],
    ['provisioning_dirty', 'attention_required', 0, 0],
    ['provisioning_wrong_ownership', 'attention_required', 0, 0],
    ['unclaimed', 'attention_required', 0, 0],
  ] as const)(
    'drains a %s Developer start reservation before accepting commands',
    async (kind, expectedLifecycle, expectedStarts, expectedGitAdds) => {
      const seeded = await seedDeveloperStartRecoveryCase(kind);
      const fake = new FakeHarnessAdapter({
        developerScenario: 'missing_output',
        holdAfterAdapterCursor: 1,
      });
      const phases: string[] = [];
      const gitAdds: readonly string[][] = [];
      const publications: ServerRealtimeMessage[] = [];
      let server: RunningV2Server | undefined;
      seeded.fixture.database.close();
      try {
        server = await startV2Server({
          environment: await environment(
            seeded.repositoryPath,
            seeded.fixture.path,
          ),
          test: {
            adapter: fake,
            onStartupPhase: (phase) => phases.push(phase),
            onPublished: (message) => publications.push(message),
            onGitCall: (args) => {
              if (args.includes('add') && args.includes('worktree')) {
                (gitAdds as string[][]).push([...args]);
              }
            },
          },
        });
        const snapshot = v2ProjectSnapshotSchema.parse(
          await fetch(
            `${server.origin}/api/v2/projects/${seeded.fixture.project.id}/snapshot`,
          ).then((response) => response.json()),
        );
        expect(
          snapshot.developerAttempts?.find(({ id }) => id === seeded.attemptId),
        ).toMatchObject({ lifecycle: expectedLifecycle });
        expect(fake.startCount).toBe(expectedStarts);
        expect(gitAdds).toHaveLength(expectedGitAdds);
        const attemptEventTypes = publications.flatMap((message) => {
          if (message.type !== 'v2.domain_event') return [];
          const payload = message.event.payload as {
            attempt?: { id?: string };
          };
          return payload.attempt?.id === seeded.attemptId
            ? [message.event.type]
            : [];
        });
        expect(attemptEventTypes).toEqual(
          kind === 'unclaimed'
            ? ['developer_attempt.changed']
            : expectedLifecycle === 'attention_required'
              ? ['developer_workspace.changed']
              : kind === 'provisioning'
                ? ['developer_attempt.changed']
                : ['developer_workspace.changed', 'developer_attempt.changed'],
        );
        if (kind !== 'unclaimed') {
          const replay = await fetch(`${server.origin}/api/v2/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(seeded.envelope),
          });
          expect(replay.status).toBe(
            expectedLifecycle === 'active' ? 200 : 409,
          );
          expect(
            v2CommandResultSchema.parse(await replay.json()),
          ).toMatchObject(
            expectedLifecycle === 'active'
              ? {
                  ok: true,
                  commandType: 'developer_attempt.start',
                  attempt: { id: seeded.attemptId, lifecycle: 'active' },
                }
              : {
                  ok: false,
                  commandType: 'developer_attempt.start',
                  error: { code: 'developer_workspace_conflict' },
                },
          );
          expect(fake.startCount).toBe(expectedStarts);
        }
        const verification = openV2Database(seeded.fixture.path);
        try {
          expect(
            new DeveloperRepository(verification).startReservation(
              seeded.envelope.idempotencyKey,
            ),
          ).toBeUndefined();
          const stored = new V2CommandRepository(verification).find(
            seeded.envelope.idempotencyKey,
          );
          if (kind === 'unclaimed') expect(stored).toBeUndefined();
          else expect(stored).toBeDefined();
          expect(
            new ExecutionRepository(verification)
              .list(seeded.fixture.project.id)
              .filter(
                (execution) =>
                  execution.assignment.kind === 'developer_task' &&
                  execution.assignment.attemptId === seeded.attemptId,
              ),
          ).toHaveLength(expectedStarts);
        } finally {
          verification.close();
        }
        expect(phases).toEqual([
          'executions_reconciled',
          'developer_attempts_reconciled',
          'planning_bound_cycles_reconciled',
          'planning_pending_reservations_reconciled',
          'recovery_window_published',
          'recovered_sessions_attached',
          'pending_launches_drained',
          'accepting_commands',
        ]);
      } finally {
        await server?.close();
        if (existsSync(seeded.workspacePath)) {
          execFileSync(
            seeded.git.path,
            [
              '-C',
              seeded.repositoryPath,
              'worktree',
              'remove',
              '--force',
              seeded.workspacePath,
            ],
            { shell: false },
          );
        }
        seeded.fixture.close();
      }
    },
    30_000,
  );

  it('fails closed when successful start replay identity is corrupt', async () => {
    const seeded = await seedDeveloperStartRecoveryCase('reserved_before_git');
    const requestHash = hashV2Command(seeded.envelope.command);
    const exactResult = {
      ok: true as const,
      commandType: 'developer_attempt.start' as const,
      schemaVersion: 1 as const,
      attempt: seeded.attempt,
      board: seeded.board,
    };
    const corruptions = [
      ['attempt.projectId', randomUUID()],
      ['attempt.assignment.projectId', randomUUID()],
      ['board.projectId', randomUUID()],
      ['attempt.taskId', randomUUID()],
      ['attempt.assignment.taskId', randomUUID()],
      ['attempt.taskCurrentRevision', seeded.attempt.taskCurrentRevision + 1],
      [
        'attempt.assignment.taskCurrentRevision',
        seeded.attempt.assignment.taskCurrentRevision + 1,
      ],
      ['attempt.deliveryPlanId', randomUUID()],
      ['attempt.assignment.deliveryPlanId', randomUUID()],
      ['attempt.deliveryPlanRevision', seeded.attempt.deliveryPlanRevision + 1],
      [
        'attempt.assignment.deliveryPlanRevision',
        seeded.attempt.assignment.deliveryPlanRevision + 1,
      ],
      ['attempt.profileId', randomUUID()],
      ['attempt.profileRevision', seeded.attempt.profileRevision + 1],
    ] as const;
    const setPath = (path: string, value: string | number) => {
      const result = structuredClone(exactResult) as unknown as Record<
        string,
        unknown
      >;
      const segments = path.split('.');
      const property = segments.pop()!;
      let target = result;
      for (const segment of segments) {
        target = target[segment] as Record<string, unknown>;
      }
      target[property] = value;
      return result;
    };
    inImmediateTransaction(seeded.fixture.database, () => {
      new V2CommandRepository(seeded.fixture.database).storeInTransaction({
        idempotencyKey: seeded.envelope.idempotencyKey,
        commandType: seeded.envelope.command.type,
        requestHash,
        result: exactResult,
        createdAt: seeded.attempt.createdAt,
      });
      const insert = seeded.fixture.database.prepare(
        `INSERT INTO command_results (
           idempotency_key, command_type, request_hash, result_json, created_at
         ) VALUES (?, 'developer_attempt.start', ?, ?, ?)`,
      );
      for (const [path, value] of corruptions) {
        insert.run(
          `corrupt-start:${path}`,
          requestHash,
          canonicalJson(setPath(path, value)),
          seeded.attempt.createdAt,
        );
      }
    });
    const fake = new FakeHarnessAdapter();
    const publications: ServerRealtimeMessage[] = [];
    const gitAdds: readonly string[][] = [];
    seeded.fixture.database.close();
    let server: RunningV2Server | undefined;
    try {
      server = await startV2Server({
        environment: await environment(
          seeded.repositoryPath,
          seeded.fixture.path,
        ),
        test: {
          adapter: fake,
          onPublished: (message) => publications.push(message),
          onGitCall: (args) => {
            if (args.includes('add') && args.includes('worktree')) {
              (gitAdds as string[][]).push([...args]);
            }
          },
        },
      });
      const durableCounts = () => {
        const database = openV2Database(seeded.fixture.path);
        try {
          return ['domain_events', 'worker_executions'].map(
            (table) =>
              (
                database
                  .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                  .get() as { count: number }
              ).count,
          );
        } finally {
          database.close();
        }
      };
      const before = durableCounts();
      const publishedBefore = publications.length;
      for (const [path] of corruptions) {
        const response = await fetch(`${server.origin}/api/v2/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...seeded.envelope,
            idempotencyKey: `corrupt-start:${path}`,
          }),
        });
        expect(response.status, path).toBe(503);
        expect(await response.json(), path).toMatchObject({
          ok: false,
          commandType: 'developer_attempt.start',
          error: { code: 'audit_barrier_tripped' },
        });
      }
      const exact = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seeded.envelope),
      });
      expect(exact.status).toBe(200);
      expect(await exact.json()).toEqual(exactResult);
      expect(
        await fetch(`${server.origin}/api/v2/health`).then((response) =>
          response.json(),
        ),
      ).toMatchObject({ status: 'audit_barrier_tripped' });
      expect(durableCounts()).toEqual(before);
      expect(publications).toHaveLength(publishedBefore);
      expect(fake.startCount).toBe(0);
      expect(gitAdds).toHaveLength(0);
      expect(existsSync(seeded.workspacePath)).toBe(false);
    } finally {
      await server?.close();
      seeded.fixture.close();
    }
  }, 30_000);

  it.each([
    'developer_attempt.start',
    'developer_attempt.interrupt',
    'developer_attempt.replace_execution',
  ] as const)(
    'fails closed on a corrupt durable %s replay',
    async (commandType) => {
      const fixture = createV2TestDatabase();
      const root = temporaryDirectory();
      const idempotencyKey = randomUUID();
      const command =
        commandType === 'developer_attempt.start'
          ? {
              type: commandType,
              projectId: fixture.project.id,
              taskId: randomUUID(),
              expectedTaskRevision: 1,
              expectedDeliveryPlanId: randomUUID(),
              expectedDeliveryPlanRevision: 1,
              profileId: fixture.profileRevision.profileId,
              profileRevision: fixture.profileRevision.revision,
            }
          : {
              type: commandType,
              projectId: fixture.project.id,
              attemptId: randomUUID(),
              expectedAttemptRevision: 1,
            };
      fixture.database
        .prepare(
          `INSERT INTO command_results (
             idempotency_key, command_type, request_hash, result_json, created_at
           ) VALUES (?, ?, ?, '{}', ?)`,
        )
        .run(
          idempotencyKey,
          commandType,
          hashV2Command(command),
          '2026-09-01T00:00:00.000Z',
        );
      fixture.database.close();
      const server = await startV2Server({
        environment: await environment(root, fixture.path),
        test: { adapter: new FakeHarnessAdapter() },
      });
      servers.push(server);

      const response = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          actor: { kind: 'human' },
          command,
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        commandType,
        error: { code: 'audit_barrier_tripped' },
      });
      expect(
        await fetch(`${server.origin}/api/v2/health`).then((health) =>
          health.json(),
        ),
      ).toMatchObject({ status: 'audit_barrier_tripped' });
    },
  );

  it.each([
    'developer_attempt.start',
    'developer_attempt.interrupt',
    'developer_attempt.replace_execution',
  ] as const)(
    'keeps the barrier healthy for a durable %s idempotency conflict',
    async (commandType) => {
      const fixture = createV2TestDatabase();
      const root = temporaryDirectory();
      const idempotencyKey = randomUUID();
      const command =
        commandType === 'developer_attempt.start'
          ? {
              type: commandType,
              projectId: fixture.project.id,
              taskId: randomUUID(),
              expectedTaskRevision: 1,
              expectedDeliveryPlanId: randomUUID(),
              expectedDeliveryPlanRevision: 1,
              profileId: fixture.profileRevision.profileId,
              profileRevision: fixture.profileRevision.revision,
            }
          : {
              type: commandType,
              projectId: fixture.project.id,
              attemptId: randomUUID(),
              expectedAttemptRevision: 1,
            };
      fixture.database
        .prepare(
          `INSERT INTO command_results (
             idempotency_key, command_type, request_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          idempotencyKey,
          commandType,
          'a'.repeat(64),
          canonicalJson({
            ok: false,
            commandType,
            error: { code: 'invalid_request', message: 'prior result' },
          }),
          '2026-09-01T00:00:00.000Z',
        );
      fixture.database.close();
      const server = await startV2Server({
        environment: await environment(root, fixture.path),
        test: { adapter: new FakeHarnessAdapter() },
      });
      servers.push(server);

      const response = await fetch(`${server.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          actor: { kind: 'human' },
          command,
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        commandType,
        error: { code: 'idempotency_conflict' },
      });
      expect(
        await fetch(`${server.origin}/api/v2/health`).then((health) =>
          health.json(),
        ),
      ).toEqual({ status: 'ok' });
    },
  );

  it('replays an unreceipted Developer report after forced process loss before accepting commands', async () => {
    const fixture = createV2TestDatabase();
    const root = temporaryDirectory();
    const repositoryPath = join(root, 'repository');
    const git = await approveV2GitExecutable({
      pathValue: process.env.PATH ?? process.env.Path,
      workspaceRoot: root,
    });
    let first: Awaited<ReturnType<typeof startBuiltServer>> | undefined;
    let second: RunningV2Server | undefined;
    let workspacePath: string | undefined;
    try {
      mkdirSync(repositoryPath);
      execFileSync(git.path, ['init', repositoryPath], { shell: false });
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.email', 'test@mesh.local'],
        { shell: false },
      );
      execFileSync(
        git.path,
        ['-C', repositoryPath, 'config', 'user.name', 'Mesh test'],
        { shell: false },
      );
      writeFileSync(join(repositoryPath, 'README.md'), '# Todo\n');
      execFileSync(git.path, ['-C', repositoryPath, 'add', '.'], {
        shell: false,
      });
      execFileSync(git.path, ['-C', repositoryPath, 'commit', '-m', 'seed'], {
        shell: false,
      });
      const headCommit = execFileSync(
        git.path,
        ['-C', repositoryPath, 'rev-parse', 'HEAD'],
        { encoding: 'utf8', shell: false },
      ).trim();
      const commonDirectory = join(repositoryPath, '.git');
      fixture.database
        .prepare(
          `UPDATE projects SET repository_path = ?, git_common_directory = ?,
             repository_identity = ?, head_commit = ? WHERE id = ?`,
        )
        .run(
          repositoryPath,
          commonDirectory,
          process.platform === 'win32'
            ? commonDirectory.toLowerCase()
            : commonDirectory,
          headCommit,
          fixture.project.id,
        );
      const developerProfile = workerProfileRevisionSchema.parse({
        ...fixture.profileRevision,
        name: 'developer-worker',
        displayName: 'Developer worker',
        document: {
          ...fixture.profileRevision.document,
          metadata: {
            ...fixture.profileRevision.document.metadata,
            name: 'developer-worker',
            displayName: 'Developer worker',
          },
          spec: {
            ...fixture.profileRevision.document.spec,
            assignmentKinds: ['developer_task'],
            outputSchema: DEVELOPER_REPORT_SCHEMA,
          },
        },
      });
      fixture.database
        .prepare(
          `UPDATE worker_profiles SET name = ?, display_name = ? WHERE id = ?`,
        )
        .run(
          developerProfile.name,
          developerProfile.displayName,
          developerProfile.profileId,
        );
      fixture.database
        .prepare(
          `UPDATE worker_profile_revisions SET normalized_json = ?
           WHERE profile_id = ? AND revision = ?`,
        )
        .run(
          canonicalJson(developerProfile.document),
          developerProfile.profileId,
          developerProfile.revision,
        );
      const planning = new PlanningRepository(fixture.database);
      const seeded = approveTestDeliveryPlan(fixture, planning);
      const authority = planning.taskExecutionAuthority(
        fixture.project.id,
        seeded.taskId,
      );
      if (!authority)
        throw new Error('Developer task authority was not seeded');
      fixture.database.close();

      first = await startBuiltServer({
        ...(await environment(repositoryPath, fixture.path)),
        MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO: 'completed',
        MESH_V2_FAKE_HOLD_AFTER_CURSOR: '3',
      });
      const initial = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${first.ready.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const socket = await connectProjectSocket(
        first.ready.origin,
        fixture.project.id,
        initial.cursors,
      );
      const started = v2CommandResultSchema.parse(
        await fetch(`${first.ready.origin}/api/v2/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            actor: { kind: 'human' },
            command: {
              type: 'developer_attempt.start',
              projectId: fixture.project.id,
              taskId: authority.task.id,
              expectedTaskRevision: authority.task.revision,
              expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
              expectedDeliveryPlanRevision:
                authority.deliveryPlan.plan.revision,
              profileId: developerProfile.profileId,
              profileRevision: developerProfile.revision,
            },
          }),
        }).then((response) => response.json()),
      );
      if (!started.ok || started.commandType !== 'developer_attempt.start')
        throw new Error('Developer attempt did not start');
      workspacePath = started.attempt.workspace.path;
      await socket.waitFor(
        (message) =>
          message.type === 'v2.runtime_event' &&
          message.event.adapterCursor === 3,
      );
      await socket.close();
      first.child.kill('SIGKILL');
      await first.exited;

      const recoveryDatabase = openV2Database(fixture.path);
      try {
        const developers = new DeveloperRepository(recoveryDatabase);
        const executions = new ExecutionRepository(recoveryDatabase);
        const events = new V2EventStore(recoveryDatabase);
        const attempt = developers.attempt(started.attempt.id);
        if (!attempt) throw new Error('Developer attempt was not persisted');
        const execution = executions.get(attempt.controllingExecutionId!);
        if (!execution)
          throw new Error('Developer execution was not persisted');
        const assignment = developerTaskAssignmentSchema.parse(
          attempt.assignment,
        );
        const report = {
          schema: DEVELOPER_REPORT_SCHEMA,
          disposition: 'completed' as const,
          attemptId: attempt.id,
          executionId: execution.id,
          taskId: attempt.taskId,
          taskContractRevision: attempt.taskContractRevision,
          requirementCoverage: assignment.requirementRevisions.map(
            (requirement) => ({
              recordId: requirement.recordId,
              recordRevision: requirement.recordRevision,
              passed: true as const,
              evidence: [{ summary: 'Recovered deterministic requirement.' }],
            }),
          ),
          criterionCoverage: assignment.acceptanceCriteria.map(
            (text, index) => ({
              index,
              text,
              passed: true as const,
              evidence: [{ summary: 'Recovered deterministic criterion.' }],
            }),
          ),
          changedArtifacts: [
            { path: 'todo-m4.txt', summary: 'Persisted Todo evidence.' },
          ],
          verification: assignment.verification.map((command) => ({
            command,
            passed: true as const,
            evidence: [{ summary: 'Recovered deterministic verification.' }],
          })),
          unresolvedConcerns: [],
          workspace: { headCommit: headCommit, dirty: true },
        };
        inImmediateTransaction(recoveryDatabase, () => {
          events.appendRuntimeWithDiagnosticInTransaction(
            fixture.project.id,
            {
              projectId: fixture.project.id,
              executionId: execution.id,
              adapterId: 'fake',
              adapterCursor: execution.lastAdapterCursor + 1,
              receivedAt: '2026-09-01T00:00:04.000Z',
              payload: { source: 'forced-crash' },
            },
            {
              projectId: fixture.project.id,
              executionId: execution.id,
              adapterCursor: execution.lastAdapterCursor + 1,
              occurredAt: '2026-09-01T00:00:04.000Z',
              type: 'worker_execution.structured_output',
              payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
            },
          );
        });
      } finally {
        recoveryDatabase.close();
      }

      const phases: string[] = [];
      const publications: Array<{
        message: ServerRealtimeMessage;
        beforeListen: boolean;
      }> = [];
      let listening = false;
      second = await startV2Server({
        environment: await environment(repositoryPath, fixture.path),
        test: {
          adapter: new FakeHarnessAdapter(),
          onStartupPhase: (phase) => phases.push(phase),
          onPublished: (message) => {
            publications.push({ message, beforeListen: !listening });
          },
        },
      });
      listening = true;
      servers.push(second);

      const snapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${second.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      expect(snapshot.developerReports).toHaveLength(1);
      expect(snapshot.developerAttempts).toMatchObject([
        { id: started.attempt.id, lifecycle: 'completed' },
      ]);
      const replayedReports = publications.filter(
        ({ message }) =>
          message.type === 'v2.domain_event' &&
          message.event.type === 'developer_report.recorded',
      );
      expect(replayedReports).toHaveLength(1);
      expect(replayedReports.every(({ beforeListen }) => beforeListen)).toBe(
        true,
      );
      expect(
        publications.filter(
          ({ message }) =>
            message.type === 'v2.domain_event' &&
            message.event.type === 'task.lifecycle_changed',
        ),
      ).toHaveLength(1);
      expect(phases).toEqual([
        'executions_reconciled',
        'developer_attempts_reconciled',
        'planning_bound_cycles_reconciled',
        'planning_pending_reservations_reconciled',
        'recovery_window_published',
        'recovered_sessions_attached',
        'pending_launches_drained',
        'accepting_commands',
      ]);

      await second.close();
      const verifiedDatabase = openV2Database(fixture.path);
      try {
        expect(
          verifiedDatabase
            .prepare('SELECT COUNT(*) AS count FROM developer_output_receipts')
            .get(),
        ).toEqual({ count: 1 });
        expect(
          verifiedDatabase
            .prepare('SELECT COUNT(*) AS count FROM developer_reports')
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        verifiedDatabase.close();
      }
    } finally {
      if (
        first &&
        first.child.exitCode === null &&
        first.child.signalCode === null
      ) {
        first.child.kill('SIGKILL');
        await first.exited;
      }
      await second?.close();
      if (workspacePath) {
        execFileSync(
          git.path,
          [
            '-C',
            repositoryPath,
            'worktree',
            'remove',
            '--force',
            workspacePath,
          ],
          { shell: false },
        );
      }
      fixture.close();
    }
  }, 30_000);

  it('serves packaged canonical guidance without weakening SPA or API routing', async () => {
    const root = temporaryDirectory();
    const canonicalGuidance = readFileSync(
      join(workspaceRoot, 'docs', 'development', 'session-platform.md'),
      'utf8',
    ).replaceAll('\r\n', '\n');
    const publicGuidance = readFileSync(
      join(
        workspaceRoot,
        'apps',
        'v2-web',
        'public',
        'guidance',
        'v1-session-platform.md',
      ),
      'utf8',
    ).replaceAll('\r\n', '\n');
    const canonicalV2Guidance = readFileSync(
      join(workspaceRoot, 'docs', 'development', 'v2-foundation.md'),
      'utf8',
    ).replaceAll('\r\n', '\n');
    const publicV2Guidance = readFileSync(
      join(
        workspaceRoot,
        'apps',
        'v2-web',
        'public',
        'guidance',
        'v2-foundation.md',
      ),
      'utf8',
    ).replaceAll('\r\n', '\n');
    const expectedPublicV2Guidance = canonicalV2Guidance.replace(
      '[Session platform development](session-platform.md)',
      '[Session platform development](v1-session-platform.md)',
    );
    expect(publicGuidance).toBe(canonicalGuidance);
    expect(publicV2Guidance).toBe(expectedPublicV2Guidance);

    const server = await startV2Server({
      environment: await environment(root, join(root, 'mesh-v2.sqlite')),
      test: {
        adapter: new FakeHarnessAdapter(),
        webRoot: buildProductionWebRoot(),
      },
    });
    servers.push(server);

    const [
      guidanceResponse,
      v2GuidanceResponse,
      rootResponse,
      directResponse,
      apiResponse,
    ] = await Promise.all([
      fetch(`${server.origin}/guidance/v1-session-platform.md`),
      fetch(`${server.origin}/guidance/v2-foundation.md`),
      fetch(`${server.origin}/`),
      fetch(`${server.origin}/projects/example`),
      fetch(`${server.origin}/api`),
    ]);
    const [guidanceBody, v2GuidanceBody, rootBody, directBody, apiBody] =
      await Promise.all([
        guidanceResponse.text(),
        v2GuidanceResponse.text(),
        rootResponse.text(),
        directResponse.text(),
        apiResponse.text(),
      ]);

    expect(guidanceResponse.status).toBe(200);
    expect(guidanceResponse.headers.get('content-type')).not.toContain(
      'text/html',
    );
    expect(guidanceBody.replaceAll('\r\n', '\n')).toBe(canonicalGuidance);
    expect(v2GuidanceResponse.status).toBe(200);
    expect(v2GuidanceResponse.headers.get('content-type')).not.toContain(
      'text/html',
    );
    expect(v2GuidanceBody.replaceAll('\r\n', '\n')).toBe(
      expectedPublicV2Guidance,
    );
    expect(rootResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(directBody).toBe(rootBody);
    expect(guidanceBody).not.toBe(rootBody);
    expect(apiResponse.status).toBe(404);
    expect(apiBody).not.toBe(rootBody);
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

  it('composes Todo planning commands, runtime output, and snapshots durably', async () => {
    const fixture = createV2TestDatabase();
    let awaitingHumanResolve!: () => void;
    let awaitingApprovalResolve!: () => void;
    const awaitingHuman = new Promise<void>(
      (resolve) => (awaitingHumanResolve = resolve),
    );
    const awaitingApproval = new Promise<void>(
      (resolve) => (awaitingApprovalResolve = resolve),
    );
    let structuredOutputCount = 0;
    fixture.database.close();
    try {
      const server = await startV2Server({
        environment: {
          ...(await environment(fixture.directory, fixture.path)),
          MESH_V2_TEST_FAKE_PM_SCENARIO: 'todo',
        },
        test: {
          onPublished: (message) => {
            if (
              message.type === 'v2.runtime_event' &&
              message.event.type === 'worker_execution.structured_output'
            ) {
              structuredOutputCount += 1;
            }
            if (
              message.type === 'v2.domain_event' &&
              message.event.type === 'planning_cycle.changed'
            ) {
              if (
                message.event.payload.planningCycle.cycle.lifecycle ===
                'awaiting_human'
              ) {
                awaitingHumanResolve();
              }
              if (
                message.event.payload.planningCycle.cycle.lifecycle ===
                'awaiting_approval'
              ) {
                awaitingApprovalResolve();
              }
            }
          },
        },
      });
      servers.push(server);
      const command = (body: unknown) =>
        fetch(`${server.origin}/api/v2/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async (response) => ({
          status: response.status,
          body: v2CommandResultSchema.parse(await response.json()),
        }));

      const firstEnvelope = {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId: fixture.project.id,
          expectedCycleRevision: null,
          profileId: fixture.pmProfileRevision.profileId,
          profileRevision: fixture.pmProfileRevision.revision,
          message: 'Build a Todo application.',
        },
      };
      const first = await command(firstEnvelope);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        ok: true,
        commandType: 'planning_cycle.submit_turn',
      });
      await expect(command(firstEnvelope)).resolves.toEqual(first);
      await awaitingHuman;
      const questionSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const questionCycle = questionSnapshot.planningCycles[0]!;
      expect(questionCycle.cycle.lifecycle).toBe('awaiting_human');
      expect(questionCycle.questions).toHaveLength(2);

      const secondEnvelope = (message: string) => ({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' as const },
        command: {
          type: 'planning_cycle.submit_turn' as const,
          projectId: fixture.project.id,
          planningCycleId: questionCycle.cycle.id,
          expectedCycleRevision: questionCycle.cycle.revision,
          message,
        },
      });
      const raced = await Promise.all([
        command(
          secondEnvelope('Persist locally and support keyboard controls.'),
        ),
        command(secondEnvelope('A distinct stale second answer.')),
      ]);
      expect(raced.map(({ status }) => status)).toEqual([200, 200]);
      expect(raced.filter(({ body }) => body.ok)).toHaveLength(1);
      expect(raced.find(({ body }) => !body.ok)?.body).toMatchObject({
        ok: false,
        error: { code: 'planning_cycle_revision_conflict' },
      });
      await awaitingApproval;
      const proposalSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      const proposalCycle = proposalSnapshot.planningCycles[0]!;
      const proposal = proposalCycle.proposals.at(-1)!;
      expect(proposalCycle.cycle.lifecycle).toBe('awaiting_approval');

      const approved = await command({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_proposal.approve',
          projectId: fixture.project.id,
          planningCycleId: proposalCycle.cycle.id,
          proposalId: proposal.id,
          expectedCycleRevision: proposalCycle.cycle.revision,
          expectedProposalRevision: proposal.revision,
          expectedProjectIntentRevision: proposal.baseProjectIntentRevision,
          expectedLedgerRevision: proposal.baseLedgerRevision,
        },
      });
      expect(approved).toMatchObject({
        status: 200,
        body: { ok: true, commandType: 'planning_proposal.approve' },
      });
      const approvedSnapshot = v2ProjectSnapshotSchema.parse(
        await fetch(
          `${server.origin}/api/v2/projects/${fixture.project.id}/snapshot`,
        ).then((response) => response.json()),
      );
      expect(approvedSnapshot.planningCycles[0]?.cycle.lifecycle).toBe(
        'approved',
      );
      expect(approvedSnapshot.intentLedger?.ledger.revision).toBe(1);
      expect(structuredOutputCount).toBe(2);
    } finally {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      fixture.close();
    }
  });

  it.each([
    [
      'bound_output',
      'awaiting_human',
      0,
      'planning_pending_reservations_reconciled',
    ],
    [
      'bound_terminal',
      'attention_required',
      0,
      'planning_pending_reservations_reconciled',
    ],
    [
      'unbound_terminal',
      'attention_required',
      0,
      'planning_pending_reservations_reconciled',
    ],
    [
      'pending_without_operation',
      'awaiting_human',
      1,
      'recovered_sessions_attached',
    ],
    [
      'ambiguous_before_start',
      'attention_required',
      0,
      'planning_pending_reservations_reconciled',
    ],
    [
      'ambiguous_after_start',
      'attention_required',
      0,
      'planning_pending_reservations_reconciled',
    ],
  ] as const)(
    'recovers the %s planning startup window before accepting commands',
    async (kind, expectedLifecycle, expectedStarts, publicationPhase) => {
      const seeded = await seedPlanningRecoveryCase(kind);
      const phases: string[] = [];
      const publications: Array<{
        message: ServerRealtimeMessage;
        phase: string | undefined;
      }> = [];
      seeded.fixture.database.close();
      try {
        const server = await startV2Server({
          environment: await environment(
            seeded.fixture.directory,
            seeded.fixture.path,
          ),
          test: {
            adapter: seeded.adapter,
            onStartupPhase: (phase) => phases.push(phase),
            onPublished: (message) =>
              publications.push({ message, phase: phases.at(-1) }),
          },
        });
        servers.push(server);

        const snapshot = v2ProjectSnapshotSchema.parse(
          await fetch(
            `${server.origin}/api/v2/projects/${seeded.fixture.project.id}/snapshot`,
          ).then((response) => response.json()),
        );
        const cycle = snapshot.planningCycles.find(
          ({ cycle }) => cycle.id === seeded.cycleId,
        );
        expect(cycle?.cycle.lifecycle).toBe(expectedLifecycle);
        expect(seeded.fake.startCount - seeded.startCount).toBe(expectedStarts);
        expect(seeded.fake.resumeCount - seeded.resumeCount).toBe(0);
        if (kind === 'bound_output') {
          expect(
            cycle?.turns.filter(({ actor }) => actor === 'pm'),
          ).toHaveLength(1);
          expect(cycle?.questions).toHaveLength(2);
        }
        if (kind === 'unbound_terminal') {
          expect(cycle?.turns[0]).toMatchObject({
            launchState: 'execution_bound',
            executionId: expect.any(String),
          });
        }
        if (
          kind === 'ambiguous_before_start' ||
          kind === 'ambiguous_after_start'
        ) {
          expect(seeded.operationId).toEqual(expect.any(String));
          expect(
            snapshot.attentionItems.find(
              ({ executionId }) => executionId === seeded.executionId,
            ),
          ).toMatchObject({
            message: `${seeded.operationId}: Execution has no native handle`,
          });
        }
        expect(
          publications.some(
            ({ message, phase }) =>
              phase === publicationPhase &&
              message.type === 'v2.domain_event' &&
              message.event.type === 'planning_cycle.changed' &&
              message.event.payload.planningCycle.cycle.id === seeded.cycleId,
          ),
        ).toBe(true);
        expect(phases).toEqual([
          'executions_reconciled',
          'developer_attempts_reconciled',
          'planning_bound_cycles_reconciled',
          'planning_pending_reservations_reconciled',
          'recovery_window_published',
          'recovered_sessions_attached',
          'pending_launches_drained',
          'accepting_commands',
        ]);

        const command = await fetch(`${server.origin}/api/v2/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            actor: { kind: 'human' },
            command: {
              type: 'planning_cycle.abandon',
              projectId: seeded.fixture.project.id,
              planningCycleId: randomUUID(),
              expectedCycleRevision: 0,
            },
          }),
        });
        expect(command.status).toBe(200);
        expect(v2CommandResultSchema.parse(await command.json())).toMatchObject(
          {
            ok: false,
            commandType: 'planning_cycle.abandon',
            error: { code: 'planning_cycle_not_found' },
          },
        );
      } finally {
        await Promise.all(servers.splice(0).map((server) => server.close()));
        seeded.fixture.close();
      }
    },
    30_000,
  );

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
      expect(resolve(childServer.child.spawnargs.at(-1) ?? '')).toBe(
        join(workspaceRoot, 'dist', 'apps', 'v2-server', 'main.js'),
      );
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
        if (childServer.child.connected) childServer.child.disconnect();
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
  }, 30_000);

  it('reconstructs and resumes a held execution after process loss before listen', async () => {
    const fixture = createV2TestDatabase();
    const restartedFake = new FakeHarnessAdapter();
    const startupPhases: string[] = [];
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
          adapter: immediatelyResolvingResumeAdapter(restartedFake),
          onStartupPhase: (phase) => startupPhases.push(phase),
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
      expect(
        recoveredEvents.filter(
          ({ message }) => message.type === 'v2.domain_event',
        ),
      ).toHaveLength(1);
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
      const commandResponse = await fetch(`${second.origin}/api/v2/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'worker_execution.interrupt',
            projectId: fixture.project.id,
            executionId,
            expectedRevision: recoveredSnapshot.executions.find(
              (execution) => execution.id === executionId,
            )!.revision,
          },
        }),
      });
      expect(commandResponse.status).toBe(200);
      expect(startupPhases).toEqual([
        'executions_reconciled',
        'developer_attempts_reconciled',
        'planning_bound_cycles_reconciled',
        'planning_pending_reservations_reconciled',
        'recovery_window_published',
        'recovered_sessions_attached',
        'pending_launches_drained',
        'accepting_commands',
      ]);
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
