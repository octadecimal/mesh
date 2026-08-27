import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { expect, test as base } from '@playwright/test';
import {
  idSchema,
  sessionSnapshotSchema,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReportInput,
  type MutatingCommand,
  type QaReportInput,
  type SessionSnapshot,
} from '@mesh-session-platform/contracts';

// The fake is test-only infrastructure; production selection still rejects it.
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  FakeClaudeSessionDriver,
  type FakeQaStep,
} from '../../apps/server/src/claude/fake-driver.js';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { resolveGitExecutableAtStartup } from '../../apps/server/src/platform/process-runner.js';

const require = createRequire(__filename);
const builtMain = resolve('dist/apps/server/main.js');

type FakeDriverSessionControl = {
  interrupted: boolean;
  permissionDecisions: Array<{
    requestId: string;
    decision: 'approve' | 'deny';
  }>;
  enqueue(event: unknown): void;
};

type FakeClaudeSessionDriverControl = {
  createdRequests: Array<{
    title: string;
    developer?: unknown;
    role?: { role: 'qa' };
  }>;
  createdSessions: FakeDriverSessionControl[];
  resumedRequests: Array<{
    claudeResumeId: string;
    workspacePath?: string;
    permissionMode?: string;
    developer?: unknown;
    role?: { role: 'qa' };
  }>;
  submitForReview(
    index: number,
    report: DeveloperCompletionReportInput,
  ): Promise<void>;
  markBlocked(
    index: number,
    report: DeveloperBlockerReportInput,
  ): Promise<void>;
  queueQaStep(step: FakeQaStep): void;
  submitLatestDeveloperForReview(
    report: DeveloperCompletionReportInput,
  ): Promise<void>;
  drainQaSteps(): Promise<void>;
  initialDeveloperResumeId(): string | undefined;
  latestDeveloperResumeId(): string | undefined;
};

type RunningServer = {
  origin: string;
  close(): Promise<void>;
};

type StartServerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  test: { driver: FakeClaudeSessionDriverControl; webRoot: string };
};

type StartServer = (options?: StartServerOptions) => Promise<RunningServer>;

type TaskOutcome = {
  developer: 'complete' | 'blocked';
  qa?: 'verified' | 'rejected';
  hold?: boolean;
};

type OutcomeGate = {
  promise: Promise<void>;
  release(): void;
};

const outcomeGate = (): OutcomeGate => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const promptCriteria = (prompt: string) => {
  const criteria = [...prompt.matchAll(/^- \[([^\]]+)] (.+)$/gm)].map(
    ([, id, text]) => ({ id: idSchema.parse(id), text }),
  );
  if (criteria.length === 0) {
    throw new Error('Scripted Developer prompt has no acceptance criteria');
  }
  return criteria;
};

const scriptedCompletionReport = (
  taskTitle: string,
  criteria: ReturnType<typeof promptCriteria>,
): DeveloperCompletionReportInput => ({
  idempotencyKey: idSchema.parse(randomUUID()),
  summary: `${taskTitle} completed in the deterministic fake driver.`,
  criterionResults: criteria.map((criterion) => ({
    criterionId: criterion.id,
    status: 'met',
    evidence: `Deterministic evidence for ${criterion.text}`,
  })),
  verification: [
    {
      command: `fake-driver verify ${taskTitle}`,
      outcome: 'passed',
      output: `${taskTitle} passed deterministic verification.`,
    },
  ],
  limitations: 'No known limitations in the deterministic fixture.',
  workspaceState: {
    summary: 'The temporary repository remains unchanged.',
    hasUncommittedChanges: false,
    commitsCreated: false,
  },
  reviewerNotes: null,
});

const scriptedBlockerReport = (
  taskTitle: string,
): DeveloperBlockerReportInput => ({
  idempotencyKey: idSchema.parse(randomUUID()),
  reason: `${taskTitle} encountered a deterministic blocker.`,
  evidence: 'The fake dependency probe reported the scripted blocker.',
  attemptedWork: 'Inspected the temporary repository and retried once.',
  suggestedHumanAction: 'Resolve the scripted dependency before retrying.',
  preserveWorkspace: true,
});

const scriptedQaReport = (
  taskTitle: string,
  criteria: ReturnType<typeof promptCriteria>,
  disposition: 'verified' | 'rejected',
): QaReportInput => ({
  disposition,
  criterionResults: criteria.map((criterion, index) => ({
    criterionId: criterion.id,
    status:
      disposition === 'verified' || index > 0 ? 'passed' : ('failed' as const),
    evidence: `Deterministic QA evidence for ${criterion.text}`,
  })),
  limitations: [],
  residualRisks:
    disposition === 'rejected'
      ? [`${taskTitle} requires deterministic rework.`]
      : [],
});

class ScriptedFakeClaudeSessionDriver extends FakeClaudeSessionDriver {
  private readonly taskOutcomes = new Map<string, TaskOutcome>();
  private readonly gates = new Map<string, OutcomeGate>();
  private readonly taskActions: Promise<void>[] = [];
  private readonly taskActionsByTitle = new Map<string, Promise<void>>();

  constructor(private readonly databasePath: string) {
    super({
      discovered: [
        {
          claudeResumeId: 'discovered-resume-id',
          title: 'Discovered Claude session',
        },
      ],
    });
  }

  queueTaskOutcome(taskTitle: string, outcome: TaskOutcome): void {
    if (this.taskOutcomes.has(taskTitle)) {
      throw new Error(`Task outcome already queued for ${taskTitle}`);
    }
    this.taskOutcomes.set(taskTitle, outcome);
    if (outcome.hold) this.gates.set(taskTitle, outcomeGate());
  }

  releaseTaskOutcome(taskTitle: string): void {
    const gate = this.gates.get(taskTitle);
    if (!gate) throw new Error(`No held task outcome exists for ${taskTitle}`);
    gate.release();
    this.gates.delete(taskTitle);
  }

  startedTaskTitles(): string[] {
    return this.createdRequests
      .filter((request) => request.developer)
      .map((request) => request.title);
  }

  async drainTaskOutcomes(): Promise<void> {
    await Promise.all(this.taskActions);
    await this.drainQaSteps();
  }

  async waitForTaskOutcome(taskTitle: string): Promise<void> {
    const action = this.taskActionsByTitle.get(taskTitle);
    if (!action) throw new Error(`No task outcome started for ${taskTitle}`);
    await action;
    await this.drainQaSteps();
  }

  override async create(
    request: Parameters<FakeClaudeSessionDriver['create']>[0],
  ) {
    const session = await super.create(request);
    const outcome = request.developer
      ? this.taskOutcomes.get(request.title)
      : undefined;
    if (request.developer && outcome) {
      const action = this.runTaskOutcome(
        request.title,
        request.developer,
        outcome,
      );
      this.taskActions.push(action);
      this.taskActionsByTitle.set(request.title, action);
      void action.catch(() => undefined);
    }
    return session;
  }

  private async runTaskOutcome(
    taskTitle: string,
    developer: NonNullable<
      Parameters<FakeClaudeSessionDriver['create']>[0]['developer']
    >,
    outcome: TaskOutcome,
  ): Promise<void> {
    await this.waitForActiveRunItem(taskTitle);
    await this.gates.get(taskTitle)?.promise;
    const criteria = promptCriteria(developer.initialPrompt);
    if (outcome.qa) {
      const queue = (
        this as unknown as {
          qaSteps: FakeQaStep[];
        }
      ).qaSteps;
      queue.push({
        type: `qa.${outcome.qa}`,
        report: scriptedQaReport(taskTitle, criteria, outcome.qa),
      });
    }
    if (outcome.developer === 'blocked') {
      await developer.controls.markBlocked(scriptedBlockerReport(taskTitle));
      return;
    }
    await developer.controls.submitForReview(
      scriptedCompletionReport(taskTitle, criteria),
    );
  }

  private async waitForActiveRunItem(taskTitle: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const database = new BetterSqlite3(this.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const row = database
        .prepare(
          `SELECT project_run_items.status
          FROM project_run_items
          JOIN tasks ON tasks.id = project_run_items.task_id
          WHERE tasks.title = ?
          ORDER BY project_run_items.queue_position DESC
          LIMIT 1`,
        )
        .get(taskTitle) as { status: string } | undefined;
      database.close();
      if (row?.status === 'active') return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for active project-run item ${taskTitle}`,
        );
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

const initializeRepository = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, 'config', 'user.email', 'mesh-e2e@example.invalid');
  git(path, 'config', 'user.name', 'Mesh E2E');
  writeFileSync(join(path, 'README.md'), '# Mesh E2E\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', 'test fixture');
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000) => {
  await expect
    .poll(predicate, {
      timeout: timeoutMs,
      message: 'Timed out waiting for observable fake Claude state',
    })
    .toBe(true);
};

export type FakeClaudeHarness = {
  origin: string;
  repositoryPath: string;
  sharedPath: string;
  worktreePath: string;
  driver: FakeClaudeSessionDriverControl;
  snapshot(): Promise<SessionSnapshot>;
  projectId(): Promise<string>;
  discoverProject(): Promise<string>;
  command(command: MutatingCommand): Promise<{ status: number; body: any }>;
  discovery(): Promise<{ status: number; body: any }>;
  waitForCreated(count?: number): Promise<void>;
  waitForResumed(count?: number): Promise<void>;
  queueTaskOutcome(taskTitle: string, outcome: TaskOutcome): void;
  releaseTaskOutcome(taskTitle: string): void;
  startedTaskTitles(): string[];
  drainTaskOutcomes(): Promise<void>;
  waitForTaskOutcome(taskTitle: string): Promise<void>;
  apiBillingEnvironmentValues(): Array<string | undefined>;
  restart(options?: {
    billingConflict?: boolean;
    recoverSessionId?: string;
  }): Promise<void>;
};

const launchHarness = async (): Promise<{
  harness: FakeClaudeHarness;
  close(): Promise<void>;
}> => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mesh-e2e-'));
  const repositoryPath = join(temporaryRoot, 'repository');
  const sharedPath = join(temporaryRoot, 'shared');
  const worktreePath = join(temporaryRoot, 'worktrees', 'acceptance');
  const dataDirectory = join(temporaryRoot, 'data');
  const databasePath = join(dataDirectory, 'mesh.sqlite');
  const trustedGitExecutable = await resolveGitExecutableAtStartup({
    pathValue: process.env.PATH ?? process.env.Path,
    workspaceRoot: temporaryRoot,
  });
  if (!trustedGitExecutable) {
    throw new Error('Expected an approved E2E Git executable');
  }
  initializeRepository(repositoryPath);
  mkdirSync(sharedPath, { recursive: true });
  mkdirSync(join(temporaryRoot, 'worktrees'), { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });

  const driver = new ScriptedFakeClaudeSessionDriver(databasePath);
  const driverControl = driver as unknown as FakeClaudeSessionDriverControl;
  driverControl.queueQaStep = (step) => {
    const queue = (
      driver as unknown as {
        qaSteps: FakeQaStep[];
      }
    ).qaSteps;
    queue.push(step);
  };
  driverControl.submitLatestDeveloperForReview = async (report) => {
    const configurations = (
      driver as unknown as {
        developerConfigurations: Array<
          | {
              controls: {
                submitForReview(
                  value: DeveloperCompletionReportInput,
                ): Promise<void>;
              };
            }
          | undefined
        >;
      }
    ).developerConfigurations;
    let index = configurations.length - 1;
    while (index >= 0 && !configurations[index]) index -= 1;
    const configuration = configurations[index];
    if (!configuration) {
      throw new Error('No role-aware Developer runtime is available');
    }
    await configuration.controls.submitForReview(report);
  };
  driverControl.initialDeveloperResumeId = () => {
    const index = driver.createdRequests.findIndex(
      (request) => request.developer,
    );
    return index < 0
      ? undefined
      : driver.createdSessions[index]?.claudeResumeId;
  };
  driverControl.latestDeveloperResumeId = () =>
    [...driver.resumedRequests].reverse().find((request) => request.developer)
      ?.claudeResumeId;
  const startServer = (require(builtMain) as { startServer: StartServer })
    .startServer;
  let server: RunningServer;
  const billingEnvironmentValues: Array<string | undefined> = [];

  const start = async (billingConflict = false) => {
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      MESH_HOST: '127.0.0.1',
      MESH_PORT: '0',
      MESH_DATA_DIR: dataDirectory,
      MESH_DATABASE_PATH: 'mesh.sqlite',
      MESH_WORKSPACE_ROOT: temporaryRoot,
      MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      ANTHROPIC_API_KEY: billingConflict ? 'forbidden-e2e-value' : undefined,
    };
    billingEnvironmentValues.push(environment.ANTHROPIC_API_KEY);
    server = await startServer({
      environment,
      test: { driver: driverControl, webRoot: resolve('dist/apps/web') },
    });
  };

  await start();

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${server.origin}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  const post = (command: unknown) =>
    request('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
  const envelope = (command: MutatingCommand) => ({
    protocolVersion: 1,
    idempotencyKey: randomUUID(),
    command,
  });
  const projectId = async () => {
    const project = (await request('/api/snapshot')).body.projects?.[0];
    if (!project?.id) throw new Error('No discovered E2E project is available');
    return project.id as string;
  };
  const discoverProject = async () => {
    const existing = (await request('/api/snapshot')).body.projects?.[0];
    if (!existing) {
      await post({
        protocolVersion: 1,
        type: 'projects.discover',
        payload: {},
      });
    }
    return projectId();
  };

  const harness: FakeClaudeHarness = {
    get origin() {
      return server.origin;
    },
    repositoryPath,
    sharedPath,
    worktreePath,
    driver: driverControl,
    snapshot: async () =>
      sessionSnapshotSchema.parse((await request('/api/snapshot')).body),
    projectId,
    discoverProject,
    command: (command) => post(envelope(command)),
    discovery: async () =>
      post({
        protocolVersion: 1,
        type: 'sessions.discover',
        payload: { projectId: await discoverProject() },
      }),
    waitForCreated: (count = 1) =>
      waitUntil(() => driver.createdSessions.length >= count),
    waitForResumed: (count = 1) =>
      waitUntil(() => driver.resumedRequests.length >= count),
    queueTaskOutcome: (taskTitle, outcome) =>
      driver.queueTaskOutcome(taskTitle, outcome),
    releaseTaskOutcome: (taskTitle) => driver.releaseTaskOutcome(taskTitle),
    startedTaskTitles: () => driver.startedTaskTitles(),
    drainTaskOutcomes: () => driver.drainTaskOutcomes(),
    waitForTaskOutcome: (taskTitle) => driver.waitForTaskOutcome(taskTitle),
    apiBillingEnvironmentValues: () => [...billingEnvironmentValues],
    restart: async ({ billingConflict = false, recoverSessionId } = {}) => {
      await server.close();
      if (recoverSessionId) {
        const database = new BetterSqlite3(databasePath);
        database
          .prepare(
            "UPDATE sessions SET lifecycle_state = 'running' WHERE id = ?",
          )
          .run(recoverSessionId);
        database.close();
      }
      await start(billingConflict);
    },
  };

  return {
    harness,
    close: async () => {
      await server.close();
      const root = resolve(temporaryRoot);
      if (
        !basename(root).startsWith('mesh-e2e-') ||
        !root.startsWith(resolve(tmpdir()))
      ) {
        throw new Error(`Refusing to remove unexpected E2E path: ${root}`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export const test = base.extend<{ harness: FakeClaudeHarness }>({
  harness: async ({ browserName }, use) => {
    void browserName;
    const running = await launchHarness();
    try {
      await use(running.harness);
    } finally {
      await running.close();
    }
  },
});

export { expect };
