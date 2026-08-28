import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import {
  projectSchema,
  sessionSchema,
  taskSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { openDatabase, type Database } from './database.js';
import { migrate } from './migrate.js';
import { CommandRepository } from '../repositories/command-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { ProjectRunRepository } from '../repositories/project-run-repository.js';
import { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import { SessionRepository } from '../repositories/session-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { WorkspaceRepository } from '../repositories/workspace-repository.js';
import { waitForWorkerMessage } from '../test/wait-for-worker-message.js';

const runProductionBuild = (
  workspaceRoot: string,
  outputPath: string,
): void => {
  const buildEnvironment = { ...process.env };
  delete buildEnvironment.NX_INVOCATION_ROOT_PID;
  delete buildEnvironment.NX_TASK_HASH;
  delete buildEnvironment.NX_TASK_TARGET_CONFIGURATION;
  delete buildEnvironment.NX_TASK_TARGET_PROJECT;
  delete buildEnvironment.NX_TASK_TARGET_TARGET;
  const pnpmArgs = [
    'nx',
    'build',
    'server',
    '--skip-nx-cache',
    `--outputPath=${relative(workspaceRoot, outputPath).replace(/\\/g, '/')}`,
  ];
  const options = {
    cwd: workspaceRoot,
    env: buildEnvironment,
    shell: false,
    stdio: 'pipe',
    timeout: 120_000,
  } as const;

  try {
    execFileSync(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      ['pnpm', ...pnpmArgs],
      options,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const details = error instanceof Error ? error.message : String(error);
    if (
      code !== 'EINVAL' &&
      code !== 'ENOENT' &&
      !/pnpm.+(?:not found|not recognized)/i.test(details)
    ) {
      throw error;
    }

    const corepackHome =
      process.env.COREPACK_HOME ??
      (process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? tmpdir(), 'node', 'corepack')
        : join(
            process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
            'node',
            'corepack',
          ));
    const cachedPnpm = globSync('v1/pnpm/*/bin/pnpm.cjs', {
      cwd: corepackHome,
    }).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    )[0];
    const npmExecPath =
      process.env.npm_execpath ??
      (cachedPnpm && join(corepackHome, cachedPnpm));
    if (!npmExecPath) {
      throw new Error(
        'Corepack could not locate pnpm and npm_execpath is unavailable',
      );
    }
    execFileSync(process.execPath, [npmExecPath, ...pnpmArgs], {
      ...options,
      env: { ...options.env, npm_execpath: npmExecPath },
    });
  }
};

const tableNames = (database: Database): string[] =>
  database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);

const assertPlanningStorageConstraints = (database: Database): void => {
  const at = '2026-08-27T00:00:00.000Z';
  new ProjectRepository(database).create(
    projectSchema.parse({
      id: 'constraint-other-project',
      displayName: 'Other constraint project',
      repositoryPath: 'C:/code/constraint-other-project',
      discoveredAt: at,
      discoveryMetadata: {},
    }),
  );
  for (const [id, projectId] of [
    ['constraint-prerequisite-task', 'constraint-project'],
    ['constraint-other-task', 'constraint-other-project'],
  ]) {
    new TaskRepository(database).create(
      taskSchema.parse({
        id,
        projectId,
        title: `Task ${id}`,
        description: 'Persist ownership constraints',
        acceptanceCriteria: ['Reject cross-project rows'],
        priority: 'normal',
        rank: id,
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      }),
    );
  }
  new WorkspaceRepository(database).create(
    workspaceSchema.parse({
      id: 'constraint-other-workspace',
      projectId: 'constraint-other-project',
      type: 'shared',
      path: 'C:/code/constraint-other-project',
    }),
  );
  new SessionRepository(database).create(
    sessionSchema.parse({
      id: 'constraint-other-session',
      projectId: 'constraint-other-project',
      workspaceId: 'constraint-other-workspace',
      title: 'Other constraint session',
      permissionMode: 'safe_auto',
      lifecycleState: 'running',
      createdAt: at,
      updatedAt: at,
    }),
  );
  const insertPlan = database.prepare(
    `INSERT INTO project_plans (
      id, project_id, goal, constraints_json, non_goals_json, policy_version,
      status, revision, current_base_id, current_session_id,
      latest_proposal_ordinal, attention_json, created_by_json, created_at,
      updated_at, terminal_at, terminal_by_json, terminal_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertPlan.run(
    'planning-constraint-plan',
    'constraint-project',
    'Persist planning constraints',
    '[]',
    '[]',
    'v1',
    'planning',
    1,
    'planning-constraint-base',
    null,
    0,
    null,
    '{"type":"human","id":"operator"}',
    at,
    at,
    null,
    null,
    null,
  );
  expect(() =>
    insertPlan.run(
      'planning-constraint-plan-second',
      'constraint-project',
      'Second active plan',
      '[]',
      '[]',
      'v1',
      'awaiting_review',
      1,
      'planning-constraint-base-second',
      null,
      0,
      null,
      '{"type":"human","id":"operator"}',
      at,
      at,
      null,
      null,
      null,
    ),
  ).toThrow();

  database
    .prepare(
      `INSERT INTO project_plan_bases (
        id, plan_id, ordinal, repository_identity, tasks_json,
        dependencies_json, project_archived_at, project_revision,
        policy_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'planning-constraint-base',
      'planning-constraint-plan',
      1,
      'C:/code/constraint-project',
      '[]',
      '[]',
      null,
      1,
      1,
      at,
    );
  database
    .prepare(
      `INSERT INTO project_plan_sessions (
        session_id, plan_id, project_id, capability_generation, started_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'constraint-session',
      'planning-constraint-plan',
      'constraint-project',
      1,
      at,
      null,
    );
  expect(() =>
    database
      .prepare(
        `INSERT INTO project_plan_sessions (
          session_id, plan_id, project_id, capability_generation, started_at,
          ended_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'constraint-other-session',
        'planning-constraint-plan',
        'constraint-project',
        1,
        at,
        null,
      ),
  ).toThrow();
  database
    .prepare(
      `INSERT INTO project_plan_proposals (
        id, plan_id, base_id, project_id, ordinal, plan_revision,
        capability_generation, session_id, assumptions_json, risks_json,
        exclusions_json, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'planning-constraint-proposal',
      'planning-constraint-plan',
      'planning-constraint-base',
      'constraint-project',
      1,
      1,
      1,
      'constraint-session',
      '[]',
      '[]',
      '[]',
      at,
    );
  const insertProposalTask = database.prepare(
    `INSERT INTO project_plan_proposal_tasks (
      proposal_id, task_key, ordinal, title, description,
      acceptance_criteria_json, priority, labels_json, rationale, goal_mapping
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProposalTask.run(
    'planning-constraint-proposal',
    'planning-constraint-proposal-task',
    0,
    'Constraint proposal task',
    'Persist planning constraints',
    '["Persist planning constraints"]',
    'normal',
    '[]',
    'Required for test coverage',
    'Planning storage',
  );
  expect(() =>
    insertProposalTask.run(
      'planning-constraint-proposal',
      'planning-constraint-proposal-task',
      1,
      'Duplicate proposal task',
      'Should not be stored',
      '["Should not be stored"]',
      'normal',
      '[]',
      'Duplicate local key',
      'Planning storage',
    ),
  ).toThrow();
  insertProposalTask.run(
    'planning-constraint-proposal',
    'planning-constraint-proposal-prerequisite',
    1,
    'Constraint prerequisite',
    'Persist planning dependency constraints',
    '["Persist planning dependency constraints"]',
    'normal',
    '[]',
    'Required for dependency coverage',
    'Planning storage',
  );
  expect(() =>
    database
      .prepare('UPDATE project_plan_proposals SET ordinal = ? WHERE id = ?')
      .run(2, 'planning-constraint-proposal'),
  ).toThrow();
  expect(() =>
    database
      .prepare(
        'UPDATE project_plan_proposal_tasks SET task_key = ? WHERE proposal_id = ? AND task_key = ?',
      )
      .run(
        'planning-constraint-proposal-task-renamed',
        'planning-constraint-proposal',
        'planning-constraint-proposal-task',
      ),
  ).toThrow();

  const insertProposalDependency = database.prepare(
    `INSERT INTO project_plan_proposal_dependencies (
      proposal_id, project_id, ordinal, dependent_task_key, prerequisite_type,
      prerequisite_task_key, prerequisite_task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProposalDependency.run(
    'planning-constraint-proposal',
    'constraint-project',
    0,
    'planning-constraint-proposal-task',
    'proposal_task',
    'planning-constraint-proposal-prerequisite',
    null,
  );
  expect(() =>
    insertProposalDependency.run(
      'planning-constraint-proposal',
      'constraint-project',
      1,
      'planning-constraint-proposal-task',
      'proposal_task',
      'planning-constraint-proposal-prerequisite',
      null,
    ),
  ).toThrow();
  insertProposalDependency.run(
    'planning-constraint-proposal',
    'constraint-project',
    2,
    'planning-constraint-proposal-task',
    'existing_task',
    null,
    'constraint-task',
  );
  expect(() =>
    insertProposalDependency.run(
      'planning-constraint-proposal',
      'constraint-project',
      3,
      'planning-constraint-proposal-task',
      'existing_task',
      null,
      'constraint-task',
    ),
  ).toThrow();
  expect(() =>
    insertProposalDependency.run(
      'planning-constraint-proposal',
      'constraint-project',
      4,
      'planning-constraint-proposal-task',
      'existing_task',
      null,
      'constraint-other-task',
    ),
  ).toThrow();

  const insertMapping = database.prepare(
    `INSERT INTO project_plan_task_mappings (
      proposal_id, proposal_task_key, project_id, task_id, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  insertMapping.run(
    'planning-constraint-proposal',
    'planning-constraint-proposal-task',
    'constraint-project',
    'constraint-task',
    at,
  );
  expect(() =>
    insertMapping.run(
      'planning-constraint-proposal',
      'planning-constraint-proposal-task',
      'constraint-project',
      'constraint-task',
      at,
    ),
  ).toThrow();
  expect(() =>
    insertMapping.run(
      'planning-constraint-proposal',
      'planning-constraint-proposal-prerequisite',
      'constraint-project',
      'constraint-other-task',
      at,
    ),
  ).toThrow();

  const insertDependency = database.prepare(
    `INSERT INTO task_dependencies (
      project_id, task_id, prerequisite_task_id, created_by_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  expect(() =>
    insertDependency.run(
      'constraint-project',
      'constraint-task',
      'constraint-task',
      '{"type":"human","id":"operator"}',
      at,
    ),
  ).toThrow();
  insertDependency.run(
    'constraint-project',
    'constraint-task',
    'constraint-prerequisite-task',
    '{"type":"human","id":"operator"}',
    at,
  );
  expect(() =>
    insertDependency.run(
      'constraint-project',
      'constraint-task',
      'constraint-prerequisite-task',
      '{"type":"human","id":"operator"}',
      at,
    ),
  ).toThrow();
  expect(() =>
    insertDependency.run(
      'constraint-project',
      'constraint-task',
      'constraint-other-task',
      '{"type":"human","id":"operator"}',
      at,
    ),
  ).toThrow();
};

const assertProjectRunConstraints = (database: Database): void => {
  const at = '2026-08-27T00:00:00.000Z';
  new ProjectRepository(database).create(
    projectSchema.parse({
      id: 'constraint-project',
      displayName: 'Constraint project',
      repositoryPath: 'C:/code/constraint-project',
      discoveredAt: at,
      discoveryMetadata: {},
    }),
  );
  new TaskRepository(database).create(
    taskSchema.parse({
      id: 'constraint-task',
      projectId: 'constraint-project',
      title: 'Constraint task',
      description: '',
      acceptanceCriteria: ['Persist constraints'],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'ready',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }),
  );
  new WorkspaceRepository(database).create(
    workspaceSchema.parse({
      id: 'constraint-workspace',
      projectId: 'constraint-project',
      type: 'shared',
      path: 'C:/code/constraint-project',
    }),
  );
  new SessionRepository(database).create(
    sessionSchema.parse({
      id: 'constraint-session',
      projectId: 'constraint-project',
      workspaceId: 'constraint-workspace',
      title: 'Constraint session',
      permissionMode: 'safe_auto',
      lifecycleState: 'running',
      createdAt: at,
      updatedAt: at,
    }),
  );
  database
    .prepare(
      `INSERT INTO project_runs (
        id, project_id, state, revision, concurrency, started_at, updated_at,
        completed_at, completion_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'constraint-run',
      'constraint-project',
      'running',
      1,
      1,
      at,
      at,
      null,
      null,
    );
  const insertRun = database.prepare(
    `INSERT INTO project_runs (
      id, project_id, state, revision, concurrency, started_at, updated_at,
      completed_at, completion_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  expect(() =>
    insertRun.run(
      'invalid-concurrency',
      'constraint-project',
      'completed',
      1,
      0,
      at,
      at,
      at,
      'invalid concurrency',
    ),
  ).toThrow();
  expect(() =>
    insertRun.run(
      'invalid-revision',
      'constraint-project',
      'completed',
      0,
      1,
      at,
      at,
      at,
      'invalid revision',
    ),
  ).toThrow();
  expect(() =>
    insertRun.run(
      'invalid-completion-reason',
      'constraint-project',
      'completed',
      1,
      1,
      at,
      at,
      at,
      null,
    ),
  ).toThrow();

  const insertItem = database.prepare(
    `INSERT INTO project_run_items (
      id, run_id, project_id, task_id, task_revision, policy_revision,
      task_automation_generation, queue_position, status, attempt_id, session_id,
      launch_idempotency_key, claimed_at, started_at, finished_at, outcome_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  expect(() =>
    insertItem.run(
      'invalid-position',
      'constraint-run',
      'constraint-project',
      'constraint-task',
      1,
      1,
      0,
      -1,
      'queued',
      null,
      null,
      'constraint-position',
      null,
      null,
      null,
      null,
    ),
  ).toThrow();
  expect(() =>
    insertItem.run(
      'invalid-not-started-timestamp',
      'constraint-run',
      'constraint-project',
      'constraint-task',
      1,
      1,
      0,
      0,
      'not_started',
      null,
      null,
      'constraint-not-started',
      null,
      at,
      at,
      'not started',
    ),
  ).toThrow();
  expect(() =>
    insertItem.run(
      'invalid-linked-pair',
      'constraint-run',
      'constraint-project',
      'constraint-task',
      1,
      1,
      0,
      0,
      'active',
      null,
      'constraint-session',
      'constraint-linked-pair',
      at,
      at,
      null,
      null,
    ),
  ).toThrow();
};

describe('migrate', () => {
  const databases: Database[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('applies the initial schema once and records it in the migration ledger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'migration.sqlite'));
    databases.push(database);

    migrate(database);
    migrate(database);

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
        )
        .all(),
    ).toEqual([{ name: 'sessions' }]);
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
      { id: '005-task-attempt-safety' },
      { id: '006-task-attempt-launch-recovery' },
      { id: '007-developer-execution' },
      { id: '008-developer-cycle-task-title' },
      { id: '009-qa-execution' },
      { id: '010-review-automation-state' },
      { id: '011-qa-interruption-repair' },
      { id: '012-project-runs' },
      { id: '013-task-attempt-project-run-source' },
      { id: '014-project-run-prelaunch-attention' },
      { id: '015-project-run-pause-reason' },
      { id: '016-project-run-automation-status' },
      { id: '017-pm-planning' },
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_attempts',
        'task_transitions',
        'project_events',
        'developer_execution_cycles',
        'developer_completion_reports',
        'developer_blocker_reports',
        'developer_review_feedback',
        'project_runs',
        'project_run_items',
        'project_plans',
        'project_plan_bases',
        'project_plan_sessions',
        'project_plan_proposals',
        'project_plan_proposal_tasks',
        'project_plan_proposal_dependencies',
        'project_plan_feedback',
        'project_plan_task_mappings',
        'task_dependencies',
      ]),
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'one_active_project_run',
        'one_open_project_run_item_per_task',
        'project_run_queue_order',
      ]),
    );
    expect(
      database
        .prepare("SELECT * FROM pragma_foreign_key_list('project_run_items')")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'project_runs', from: 'run_id' }),
        expect.objectContaining({ table: 'projects', from: 'project_id' }),
        expect.objectContaining({ table: 'tasks', from: 'task_id' }),
        expect.objectContaining({ table: 'task_attempts', from: 'attempt_id' }),
        expect.objectContaining({ table: 'sessions', from: 'session_id' }),
      ]),
    );
    assertProjectRunConstraints(database);
    assertPlanningStorageConstraints(database);
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('developer_execution_cycles') ORDER BY cid",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: 'task_snapshot_title' },
        { name: 'task_snapshot_description' },
      ]),
    );
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('task_attempts')")
        .all(),
    ).toContainEqual({ name: 'source_json' });
  });

  it('upgrades an 016 database without changing existing planning-adjacent rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-pm-planning-upgrade-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const at = '2026-08-27T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
      '009-qa-execution.sql',
      '010-review-automation-state.sql',
      '011-qa-interruption-repair.sql',
      '012-project-runs.sql',
      '013-task-attempt-project-run-source.sql',
      '014-project-run-prelaunch-attention.sql',
      '015-project-run-pause-reason.sql',
      '016-project-run-automation-status.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), at);
    }
    new ProjectRepository(database).create(
      projectSchema.parse({
        id: 'planning-upgrade-project',
        displayName: 'Planning upgrade',
        repositoryPath: 'C:/code/planning-upgrade',
        discoveredAt: at,
        discoveryMetadata: {},
      }),
    );
    new TaskRepository(database).create(
      taskSchema.parse({
        id: 'planning-upgrade-task',
        projectId: 'planning-upgrade-project',
        title: 'Preserve existing task',
        description: 'Pre-017 task row',
        acceptanceCriteria: ['Remain byte-equivalent'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: ['planning'],
        notes: 'pre-017',
        blocked: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      }),
    );
    new WorkspaceRepository(database).create(
      workspaceSchema.parse({
        id: 'planning-upgrade-workspace',
        projectId: 'planning-upgrade-project',
        type: 'shared',
        path: 'C:/code/planning-upgrade',
      }),
    );
    new SessionRepository(database).create(
      sessionSchema.parse({
        id: 'planning-upgrade-session',
        projectId: 'planning-upgrade-project',
        workspaceId: 'planning-upgrade-workspace',
        title: 'Planning upgrade session',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: at,
        updatedAt: at,
      }),
    );
    database
      .prepare(
        `INSERT INTO task_attempts (
          id, task_id, session_id, ordinal, source, actor_json, created_at,
          unlinked_at, unlinked_by_json, unlink_reason, source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-attempt',
        'planning-upgrade-task',
        'planning-upgrade-session',
        1,
        'launched',
        '{"type":"human","id":"operator"}',
        at,
        null,
        null,
        null,
        null,
      );
    database
      .prepare(
        `INSERT INTO developer_execution_cycles (
          id, attempt_id, ordinal, mode, authorized_by_json,
          authorization_command_id, policy_version, project_instructions_content,
          project_instructions_revision, task_snapshot_revision,
          task_snapshot_description, task_snapshot_acceptance_criteria_json,
          workspace_id, permission_mode, started_at, ended_at,
          terminal_disposition, completion_report_id, blocker_report_id,
          terminal_command_id, terminal_event_id, task_snapshot_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-execution',
        'planning-upgrade-attempt',
        1,
        'new',
        '{"type":"human","id":"operator"}',
        'planning-upgrade-command',
        'v1',
        '',
        1,
        1,
        'Pre-017 task row',
        '["Remain byte-equivalent"]',
        'planning-upgrade-workspace',
        'safe_auto',
        at,
        null,
        null,
        null,
        null,
        null,
        null,
        'Preserve existing task',
      );
    database
      .prepare(
        `INSERT INTO project_runs (
          id, project_id, state, revision, concurrency, started_at, updated_at,
          completed_at, completion_reason, pause_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-run',
        'planning-upgrade-project',
        'running',
        1,
        1,
        at,
        at,
        null,
        null,
        null,
      );
    database
      .prepare(
        `INSERT INTO qa_execution_cycles (
          id, task_id, attempt_id, session_id, ordinal, snapshot_json,
          review_policy, automation_generation, rejection_ordinal, disposition,
          started_at, terminal_at, report_id, terminal_command_id,
          terminal_event_id, interrupted_at, interruption_command_id,
          interruption_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-qa-execution',
        'planning-upgrade-task',
        'planning-upgrade-attempt',
        'planning-upgrade-session',
        1,
        '{}',
        'manual',
        0,
        0,
        null,
        at,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    database
      .prepare(
        `INSERT INTO processed_commands (
          id, idempotency_key, state, response_json, failure_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-command',
        'planning-upgrade-command-key',
        'completed',
        '{"accepted":true}',
        null,
        at,
        at,
      );
    database
      .prepare(
        `INSERT INTO project_events (
          id, project_id, sequence, occurred_at, type, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'planning-upgrade-event',
        'planning-upgrade-project',
        1,
        at,
        'project.changed',
        '{"pre017":true}',
      );

    const existingRows = {
      projects: database.prepare('SELECT * FROM projects').all(),
      tasks: database.prepare('SELECT * FROM tasks').all(),
      attempts: database.prepare('SELECT * FROM task_attempts').all(),
      executions: database
        .prepare('SELECT * FROM developer_execution_cycles')
        .all(),
      qaExecutions: database.prepare('SELECT * FROM qa_execution_cycles').all(),
      commands: database.prepare('SELECT * FROM processed_commands').all(),
      runs: database.prepare('SELECT * FROM project_runs').all(),
      events: database.prepare('SELECT * FROM project_events').all(),
    };
    const pre017Ledger = database
      .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
      .all();

    migrate(database);

    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        'project_plans',
        'project_plan_bases',
        'project_plan_sessions',
        'project_plan_proposals',
        'project_plan_proposal_tasks',
        'project_plan_proposal_dependencies',
        'project_plan_feedback',
        'project_plan_task_mappings',
        'task_dependencies',
      ]),
    );
    expect({
      projects: database.prepare('SELECT * FROM projects').all(),
      tasks: database.prepare('SELECT * FROM tasks').all(),
      attempts: database.prepare('SELECT * FROM task_attempts').all(),
      executions: database
        .prepare('SELECT * FROM developer_execution_cycles')
        .all(),
      qaExecutions: database.prepare('SELECT * FROM qa_execution_cycles').all(),
      commands: database.prepare('SELECT * FROM processed_commands').all(),
      runs: database.prepare('SELECT * FROM project_runs').all(),
      events: database.prepare('SELECT * FROM project_events').all(),
    }).toEqual(existingRows);
    expect(
      database
        .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
        .all(),
    ).toEqual([
      ...pre017Ledger,
      { id: '017-pm-planning', applied_at: expect.any(String) },
    ]);
  });

  it('upgrades Milestone 3 projects with the manual QA defaults', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-qa-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-26T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json,
          repository_identity, revision, created_at, updated_at, archived_at,
          developer_instructions_content, developer_instructions_revision,
          developer_instructions_updated_at, developer_instructions_updated_by_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'project-qa-upgrade',
        'QA upgrade',
        'C:/code/qa-upgrade',
        appliedAt,
        '{}',
        'C:/code/qa-upgrade',
        1,
        appliedAt,
        appliedAt,
        null,
        '',
        1,
        appliedAt,
        null,
      );

    migrate(database);

    const migratedProject = new ProjectRepository(database).get(
      'project-qa-upgrade',
    );
    expect(migratedProject?.qaConfiguration.reviewPolicy).toBe('manual');
    expect(migratedProject?.qaConfiguration.instructions).toEqual({
      content: '',
      revision: 1,
      updatedAt: appliedAt,
      updatedBy: null,
    });
  });

  it('upgrades an 011 database with project-run tables, constraints, and indexes', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-project-run-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-27T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
      '009-qa-execution.sql',
      '010-review-automation-state.sql',
      '011-qa-interruption-repair.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }

    migrate(database);

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(expect.arrayContaining(['project_runs', 'project_run_items']));
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'one_active_project_run',
        'one_open_project_run_item_per_task',
        'project_run_queue_order',
      ]),
    );
    expect(
      database
        .prepare("SELECT * FROM pragma_foreign_key_list('project_run_items')")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'project_runs', from: 'run_id' }),
        expect.objectContaining({ table: 'projects', from: 'project_id' }),
        expect.objectContaining({ table: 'tasks', from: 'task_id' }),
        expect.objectContaining({ table: 'task_attempts', from: 'attempt_id' }),
        expect.objectContaining({ table: 'sessions', from: 'session_id' }),
      ]),
    );
    assertProjectRunConstraints(database);
  });

  it('upgrades a 012 database with nullable project-run attempt provenance', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-attempt-source-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-27T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
      '009-qa-execution.sql',
      '010-review-automation-state.sql',
      '011-qa-interruption-repair.sql',
      '012-project-runs.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare(
        `INSERT INTO task_attempts (
          id, task_id, session_id, ordinal, source, actor_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-attempt',
        'legacy-task',
        'legacy-session',
        1,
        'launched',
        '{"type":"human","id":"operator-1"}',
        appliedAt,
      );
    database.exec('PRAGMA foreign_keys = ON');

    migrate(database);

    expect(
      database
        .prepare('SELECT source, source_json FROM task_attempts WHERE id = ?')
        .get('legacy-attempt'),
    ).toEqual({ source: 'launched', source_json: null });
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toContainEqual({ id: '013-task-attempt-project-run-source' });
  });

  it('upgrades a 013 database to preserve pre-launch attention outcomes', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-run-attention-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-27T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
      '009-qa-execution.sql',
      '010-review-automation-state.sql',
      '011-qa-interruption-repair.sql',
      '012-project-runs.sql',
      '013-task-attempt-project-run-source.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }
    new ProjectRepository(database).create(
      projectSchema.parse({
        id: 'attention-project',
        displayName: 'Attention project',
        repositoryPath: 'C:/code/attention-project',
        discoveredAt: appliedAt,
        discoveryMetadata: {},
      }),
    );
    new TaskRepository(database).create(
      taskSchema.parse({
        id: 'attention-task',
        projectId: 'attention-project',
        title: 'Attention task',
        description: 'Prove pre-launch failure persistence.',
        acceptanceCriteria: ['The run item requires attention.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: appliedAt,
        updatedAt: appliedAt,
      }),
    );
    database
      .prepare(
        `INSERT INTO project_runs (
          id, project_id, state, revision, concurrency, started_at, updated_at,
          completed_at, completion_reason
        ) VALUES (?, ?, 'running', 2, 1, ?, ?, NULL, NULL)`,
      )
      .run('attention-run', 'attention-project', appliedAt, appliedAt);
    database
      .prepare(
        `INSERT INTO project_run_items (
          id, run_id, project_id, task_id, task_revision, policy_revision,
          task_automation_generation, queue_position, status, attempt_id,
          session_id, launch_idempotency_key, claimed_at, started_at,
          finished_at, outcome_reason
        ) VALUES (
          ?, ?, ?, ?, 1, 1, 0, 0, 'launch_pending', NULL, NULL, ?, ?, NULL,
          NULL, NULL
        )`,
      )
      .run(
        'attention-item',
        'attention-run',
        'attention-project',
        'attention-task',
        'attention-launch',
        appliedAt,
      );

    migrate(database);
    const runs = new ProjectRunRepository(database);
    const claim = runs.get('attention-run');
    if (!claim) throw new Error('Expected migrated attention run');
    const claimedItem = claim.items[0];
    if (!claimedItem) throw new Error('Expected migrated attention item');

    expect(
      runs.finishItem({
        runId: claim.id,
        itemId: claimedItem.id,
        expectedRunRevision: claim.revision,
        status: 'attention_required',
        outcomeReason: 'task_revision_conflict',
        occurredAt: appliedAt,
      }).items[0],
    ).toMatchObject({
      status: 'attention_required',
      taskAutomationStatus: 'disabled',
      attemptId: null,
      sessionId: null,
      startedAt: null,
    });
  });

  it('preserves 009 automation actions while expanding source-cycle foreign keys', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-review-automation-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-26T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
      '008-developer-cycle-task-title.sql',
      '009-qa-execution.sql',
    ];
    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare(
        `INSERT INTO review_automation_actions (
          id, idempotency_key, project_id, task_id, attempt_id, source_cycle_id,
          action_kind, generation, status, error_code, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-action',
        'legacy-action-key',
        'legacy-project',
        'legacy-task',
        'legacy-attempt',
        'legacy-qa-cycle',
        'resume_developer',
        3,
        'pending',
        null,
        appliedAt,
        null,
      );

    migrate(database);

    expect(
      database
        .prepare(
          `SELECT id, source_developer_cycle_id, source_qa_cycle_id, generation, status
           FROM review_automation_actions_v2 WHERE id = ?`,
        )
        .get('legacy-action'),
    ).toEqual({
      id: 'legacy-action',
      source_developer_cycle_id: null,
      source_qa_cycle_id: 'legacy-qa-cycle',
      generation: 3,
      status: 'pending',
    });
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'review_automation_status',
        'review_automation_generation',
        'review_automation_rejection_count',
        'review_automation_pause_reason',
        'review_automation_updated_at',
      ]),
    );

    const currentActions = new QaExecutionRepository(database);
    expect(
      currentActions.completeAutomationAction('legacy-action', {
        status: 'completed',
        errorCode: null,
        completedAt: '2026-08-26T01:00:00.000Z',
      }),
    ).toMatchObject({ status: 'completed' });
    expect(
      database
        .prepare(
          'SELECT status, error_code, completed_at FROM review_automation_actions WHERE id = ?',
        )
        .get('legacy-action'),
    ).toEqual({
      status: 'completed',
      error_code: null,
      completed_at: '2026-08-26T01:00:00.000Z',
    });

    database
      .prepare(
        `INSERT INTO review_automation_actions (
          id, idempotency_key, project_id, task_id, attempt_id, source_cycle_id,
          action_kind, generation, status, error_code, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'rollback-action',
        'rollback-action-key',
        'legacy-project',
        'legacy-task',
        'legacy-attempt',
        'legacy-qa-cycle',
        'resume_developer',
        3,
        'pending',
        null,
        appliedAt,
        null,
      );
    database
      .prepare(
        `UPDATE review_automation_actions
         SET status = 'failed', error_code = 'rollback_failure', completed_at = ?
         WHERE id = ?`,
      )
      .run('2026-08-26T02:00:00.000Z', 'rollback-action');

    migrate(database);

    expect(
      new QaExecutionRepository(database).getAutomationAction(
        'rollback-action',
      ),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'rollback_failure',
      completedAt: '2026-08-26T02:00:00.000Z',
    });
  });

  it('allows two connections to apply startup migrations without a duplicate ledger entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
    directories.push(directory);
    const path = join(directory, 'migration.sqlite');
    const first = openDatabase(path);
    const second = openDatabase(path);
    databases.push(first, second);

    migrate(first);
    migrate(second);

    expect(
      second.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
      { id: '005-task-attempt-safety' },
      { id: '006-task-attempt-launch-recovery' },
      { id: '007-developer-execution' },
      { id: '008-developer-cycle-task-title' },
      { id: '009-qa-execution' },
      { id: '010-review-automation-state' },
      { id: '011-qa-interruption-repair' },
      { id: '012-project-runs' },
      { id: '013-task-attempt-project-run-source' },
      { id: '014-project-run-prelaunch-attention' },
      { id: '015-project-run-pause-reason' },
      { id: '016-project-run-automation-status' },
      { id: '017-pm-planning' },
    ]);
  });

  it('applies the cycle-title migration to databases with 007 already recorded', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-cycle-title-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const appliedAt = '2026-08-25T00:00:00.000Z';
    const migrationFiles = [
      '001-initial.sql',
      '002-command-state.sql',
      '003-task-board-storage.sql',
      '004-project-event-streams.sql',
      '005-task-attempt-safety.sql',
      '006-task-attempt-launch-recovery.sql',
      '007-developer-execution.sql',
    ];

    for (const file of migrationFiles) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file.slice(0, -4), appliedAt);
    }

    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'project-title-upgrade',
        'Title upgrade',
        'C:/code/title-upgrade',
        appliedAt,
        '{}',
      );
    database
      .prepare(
        `INSERT INTO workspaces (
          id, project_id, type, path, cleanup_state
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-title-upgrade',
        'project-title-upgrade',
        'shared',
        'C:/code/title-upgrade',
        'active',
      );
    database
      .prepare(
        `INSERT INTO sessions (
          id, project_id, workspace_id, title, permission_mode,
          lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-title-upgrade',
        'project-title-upgrade',
        'workspace-title-upgrade',
        'Title upgrade',
        'interactive',
        'running',
        appliedAt,
        appliedAt,
      );
    database
      .prepare(
        `INSERT INTO tasks (
          id, project_id, title, description, acceptance_criteria_json,
          priority, rank, lifecycle_state, labels_json, notes, blocked_json,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-title-upgrade',
        'project-title-upgrade',
        'Recover title',
        'Recover the snapshot title.',
        '[]',
        'normal',
        'a',
        'in_progress',
        '[]',
        '',
        'null',
        1,
        appliedAt,
        appliedAt,
      );
    database
      .prepare(
        `INSERT INTO task_attempts (
          id, task_id, session_id, ordinal, source, actor_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'attempt-title-upgrade',
        'task-title-upgrade',
        'session-title-upgrade',
        1,
        'launched',
        '{"type":"human","id":"human-1"}',
        appliedAt,
      );
    database
      .prepare(
        `INSERT INTO developer_execution_cycles (
          id, attempt_id, ordinal, mode, authorized_by_json,
          authorization_command_id, policy_version, project_instructions_content,
          project_instructions_revision, task_snapshot_revision,
          task_snapshot_description, task_snapshot_acceptance_criteria_json,
          workspace_id, permission_mode, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'cycle-title-upgrade',
        'attempt-title-upgrade',
        1,
        'new',
        '{"type":"human","id":"human-1"}',
        'command-title-upgrade',
        'developer-policy-v1',
        '',
        1,
        1,
        'Recover the snapshot title.',
        '[]',
        'workspace-title-upgrade',
        'interactive',
        appliedAt,
      );

    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('developer_execution_cycles')",
        )
        .all(),
    ).not.toEqual(expect.arrayContaining([{ name: 'task_snapshot_title' }]));

    migrate(database);

    expect(
      database
        .prepare(
          'SELECT task_snapshot_title FROM developer_execution_cycles WHERE id = ?',
        )
        .get('cycle-title-upgrade'),
    ).toEqual({ task_snapshot_title: 'Recover title' });
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toContainEqual({ id: '008-developer-cycle-task-title' });
  });

  it('serializes simultaneous startup migration attempts from two worker connections', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-migrate-worker-'),
    );
    directories.push(directory);
    const modulePath = join(directory, 'migrate.cjs');
    mkdirSync(join(directory, 'migrations'));
    copyFileSync(
      join(__dirname, 'migrations', '001-initial.sql'),
      join(directory, 'migrations', '001-initial.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '002-command-state.sql'),
      join(directory, 'migrations', '002-command-state.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '003-task-board-storage.sql'),
      join(directory, 'migrations', '003-task-board-storage.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '004-project-event-streams.sql'),
      join(directory, 'migrations', '004-project-event-streams.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '005-task-attempt-safety.sql'),
      join(directory, 'migrations', '005-task-attempt-safety.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '006-task-attempt-launch-recovery.sql'),
      join(directory, 'migrations', '006-task-attempt-launch-recovery.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '007-developer-execution.sql'),
      join(directory, 'migrations', '007-developer-execution.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '008-developer-cycle-task-title.sql'),
      join(directory, 'migrations', '008-developer-cycle-task-title.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '009-qa-execution.sql'),
      join(directory, 'migrations', '009-qa-execution.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '010-review-automation-state.sql'),
      join(directory, 'migrations', '010-review-automation-state.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '011-qa-interruption-repair.sql'),
      join(directory, 'migrations', '011-qa-interruption-repair.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '012-project-runs.sql'),
      join(directory, 'migrations', '012-project-runs.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '013-task-attempt-project-run-source.sql'),
      join(directory, 'migrations', '013-task-attempt-project-run-source.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '014-project-run-prelaunch-attention.sql'),
      join(directory, 'migrations', '014-project-run-prelaunch-attention.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '015-project-run-pause-reason.sql'),
      join(directory, 'migrations', '015-project-run-pause-reason.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '016-project-run-automation-status.sql'),
      join(directory, 'migrations', '016-project-run-automation-status.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '017-pm-planning.sql'),
      join(directory, 'migrations', '017-pm-planning.sql'),
    );
    buildSync({
      bundle: true,
      entryPoints: [join(__dirname, 'migrate.ts')],
      external: ['better-sqlite3'],
      format: 'cjs',
      outfile: modulePath,
      platform: 'node',
    });
    const databasePath = join(directory, 'concurrent.sqlite');
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const { migrate } = require(workerData.modulePath);
      const database = new Database(workerData.databasePath);
      database.pragma('busy_timeout = 5000');
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try { migrate(database); parentPort.postMessage('done'); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { database.close(); }
    `;
    const start = () =>
      new Worker(workerSource, {
        eval: true,
        workerData: { barrier, databasePath, modulePath },
      });
    const workers: Worker[] = [];

    try {
      workers.push(start());
      workers.push(start());
      await Promise.all(workers.map((worker) => waitForWorkerMessage(worker)));
      const results = Promise.all(
        workers.map((worker) => waitForWorkerMessage(worker)),
      );
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      expect(await results).toEqual(['done', 'done']);

      const database = openDatabase(databasePath);
      databases.push(database);
      expect(
        database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '001-initial' },
        { id: '002-command-state' },
        { id: '003-task-board-storage' },
        { id: '004-project-event-streams' },
        { id: '005-task-attempt-safety' },
        { id: '006-task-attempt-launch-recovery' },
        { id: '007-developer-execution' },
        { id: '008-developer-cycle-task-title' },
        { id: '009-qa-execution' },
        { id: '010-review-automation-state' },
        { id: '011-qa-interruption-repair' },
        { id: '012-project-runs' },
        { id: '013-task-attempt-project-run-source' },
        { id: '014-project-run-prelaunch-attention' },
        { id: '015-project-run-pause-reason' },
        { id: '016-project-run-automation-status' },
        { id: '017-pm-planning' },
      ]);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  }, 15_000);

  it('rejects a silent worker wait within the requested bound and removes listeners', async () => {
    const workers: Worker[] = [];

    try {
      const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true });
      workers.push(worker);

      await expect(waitForWorkerMessage(worker, 25)).rejects.toThrow(
        'Timed out waiting for worker message after 25ms',
      );
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('exit')).toBe(0);
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  });

  it('upgrades completed responses from the exact 001 table without re-executing', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', '2026-08-24T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');

    migrate(database);
    const commands = new CommandRepository(database);
    let calls = 0;
    expect(
      commands.executeOnce('old-key', () => {
        calls += 1;
        return { accepted: false };
      }),
    ).toEqual({ accepted: true });
    expect(calls).toBe(0);
    expect(
      database
        .prepare(
          'SELECT state, updated_at FROM processed_commands WHERE id = ?',
        )
        .get('old'),
    ).toEqual({ state: 'completed', updated_at: '2026-08-24T00:00:00.000Z' });
    migrate(database);
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
      { id: '005-task-attempt-safety' },
      { id: '006-task-attempt-launch-recovery' },
      { id: '007-developer-execution' },
      { id: '008-developer-cycle-task-title' },
      { id: '009-qa-execution' },
      { id: '010-review-automation-state' },
      { id: '011-qa-interruption-repair' },
      { id: '012-project-runs' },
      { id: '013-task-attempt-project-run-source' },
      { id: '014-project-run-prelaunch-attention' },
      { id: '015-project-run-pause-reason' },
      { id: '016-project-run-automation-status' },
      { id: '017-pm-planning' },
    ]);
  });

  it('upgrades discovered projects in place while preserving related records', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-task-board-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const repositoryPath = 'C:/code/existing-project';
    const discoveredAt = '2026-08-24T00:00:00.000Z';

    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database.exec(
      readFileSync(
        join(__dirname, 'migrations', '002-command-state.sql'),
        'utf8',
      ),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', discoveredAt);
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('002-command-state', discoveredAt);
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'project-existing',
        'Existing project',
        repositoryPath,
        discoveredAt,
        '{"source":"discovery"}',
      );
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'project-same-path',
        'Same path project',
        repositoryPath,
        discoveredAt,
        '{"source":"discovery"}',
      );
    database
      .prepare(
        `INSERT INTO workspaces (
          id, project_id, type, path, git_branch, git_worktree_path, owner, cleanup_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-existing',
        'project-existing',
        'shared',
        repositoryPath,
        null,
        null,
        null,
        'active',
      );
    database
      .prepare(
        `INSERT INTO sessions (
          id, claude_resume_id, project_id, workspace_id, title, permission_mode,
          lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-existing',
        null,
        'project-existing',
        'workspace-existing',
        'Existing session',
        'interactive',
        'running',
        discoveredAt,
        discoveredAt,
      );
    database
      .prepare(
        `INSERT INTO saved_layouts (
          id, project_id, session_id, workspace_id, dockview_json, sidebar_json,
          visible_panels_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'layout-existing',
        'project-existing',
        'session-existing',
        'workspace-existing',
        '{}',
        null,
        '[]',
        discoveredAt,
      );

    migrate(database);

    expect(
      database
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get('project-existing'),
    ).toMatchObject({
      id: 'project-existing',
      repository_path: repositoryPath,
      repository_identity: repositoryPath,
      revision: 1,
      created_at: discoveredAt,
      updated_at: discoveredAt,
      archived_at: null,
    });
    expect(
      database
        .prepare(
          'SELECT id, repository_identity FROM projects WHERE repository_path = ? ORDER BY id',
        )
        .all(repositoryPath),
    ).toEqual([
      { id: 'project-existing', repository_identity: repositoryPath },
      { id: 'project-same-path', repository_identity: repositoryPath },
    ]);
    expect(
      database
        .prepare('SELECT id, project_id FROM workspaces WHERE id = ?')
        .get('workspace-existing'),
    ).toEqual({ id: 'workspace-existing', project_id: 'project-existing' });
    expect(
      database
        .prepare(
          'SELECT id, project_id, workspace_id FROM sessions WHERE id = ?',
        )
        .get('session-existing'),
    ).toEqual({
      id: 'session-existing',
      project_id: 'project-existing',
      workspace_id: 'workspace-existing',
    });
    expect(
      database
        .prepare(
          'SELECT id, project_id, session_id, workspace_id FROM saved_layouts WHERE id = ?',
        )
        .get('layout-existing'),
    ).toEqual({
      id: 'layout-existing',
      project_id: 'project-existing',
      session_id: 'session-existing',
      workspace_id: 'workspace-existing',
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_attempts',
        'task_transitions',
        'project_events',
      ]),
    );
  });

  it('preserves Milestone 2 attempts while adding Developer execution storage', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-developer-execution-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const occurredAt = '2026-08-25T00:00:00.000Z';

    for (const [id, file] of [
      ['001-initial', '001-initial.sql'],
      ['002-command-state', '002-command-state.sql'],
      ['003-task-board-storage', '003-task-board-storage.sql'],
      ['004-project-event-streams', '004-project-event-streams.sql'],
      ['005-task-attempt-safety', '005-task-attempt-safety.sql'],
      [
        '006-task-attempt-launch-recovery',
        '006-task-attempt-launch-recovery.sql',
      ],
    ] as const) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(id, occurredAt);
    }
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json,
          repository_identity, revision, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'project-1',
        'Existing project',
        'C:/code/existing',
        occurredAt,
        '{}',
        'C:/code/existing',
        1,
        occurredAt,
        occurredAt,
        null,
      );
    database
      .prepare(
        `INSERT INTO workspaces (
          id, project_id, type, path, git_branch, git_worktree_path, owner, cleanup_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-1',
        'project-1',
        'shared',
        'C:/code/existing',
        null,
        null,
        null,
        'active',
      );
    database
      .prepare(
        `INSERT INTO sessions (
          id, claude_resume_id, project_id, workspace_id, title, permission_mode,
          lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-1',
        null,
        'project-1',
        'workspace-1',
        'Existing session',
        'interactive',
        'running',
        occurredAt,
        occurredAt,
      );
    database
      .prepare(
        `INSERT INTO tasks (
          id, project_id, title, description, acceptance_criteria_json, priority, rank,
          lifecycle_state, labels_json, notes, blocked_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-1',
        'project-1',
        'Existing task',
        '',
        '[]',
        'normal',
        'a',
        'in_progress',
        '[]',
        '',
        'null',
        1,
        occurredAt,
        occurredAt,
      );
    database
      .prepare(
        `INSERT INTO task_attempts (
          id, task_id, session_id, ordinal, source, actor_json, created_at,
          unlinked_at, unlinked_by_json, unlink_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'attempt-1',
        'task-1',
        'session-1',
        1,
        'launched',
        '{"type":"human","id":"operator"}',
        occurredAt,
        null,
        null,
        null,
      );

    migrate(database);

    expect(
      database
        .prepare('SELECT id, task_id, session_id, ordinal FROM task_attempts')
        .all(),
    ).toEqual([
      {
        id: 'attempt-1',
        task_id: 'task-1',
        session_id: 'session-1',
        ordinal: 1,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT developer_instructions_content, developer_instructions_revision,
                  developer_instructions_updated_at, developer_instructions_updated_by_json
           FROM projects WHERE id = ?`,
        )
        .get('project-1'),
    ).toEqual({
      developer_instructions_content: '',
      developer_instructions_revision: 1,
      developer_instructions_updated_at: occurredAt,
      developer_instructions_updated_by_json: null,
    });
  });

  it('rolls a failed 002 upgrade back to the intact 001 table and data', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'rollback.sqlite'));
    databases.push(database);
    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', '2026-08-24T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');
    database.exec('CREATE TABLE processed_commands_next (id TEXT)');

    expect(() => migrate(database)).toThrow();
    expect(
      database
        .prepare('SELECT response_json FROM processed_commands WHERE id = ?')
        .get('old'),
    ).toEqual({ response_json: '{"accepted":true}' });
    expect(database.prepare('SELECT id FROM schema_migrations').all()).toEqual([
      { id: '001-initial' },
    ]);
  });

  it('backfills durable project event high-water marks on upgrade', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-project-stream-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    for (const [id, file] of [
      ['001-initial', '001-initial.sql'],
      ['002-command-state', '002-command-state.sql'],
      ['003-task-board-storage', '003-task-board-storage.sql'],
    ] as const) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(id, '2026-08-24T00:00:00.000Z');
    }
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at,
          discovery_metadata_json, repository_identity, revision, created_at,
          updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'p1',
        'Mesh',
        'C:/code/mesh',
        '2026-08-24T00:00:00.000Z',
        '{}',
        'C:/code/mesh',
        1,
        '2026-08-24T00:00:00.000Z',
        '2026-08-24T00:00:00.000Z',
        null,
      );
    const insert = database.prepare(
      `INSERT INTO project_events (
        id, project_id, sequence, occurred_at, type, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('event-1', 'p1', 1, '2026-08-24T00:00:00.000Z', 'x', '{}');
    insert.run('event-2', 'p1', 2, '2026-08-24T00:00:00.000Z', 'x', '{}');

    migrate(database);

    expect(
      database
        .prepare(
          'SELECT project_id, high_water FROM project_event_streams WHERE project_id = ?',
        )
        .get('p1'),
    ).toEqual({ project_id: 'p1', high_water: 2 });
  });

  it('adds a nullable durable pause reason to existing project runs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-run-pause-reason-'));
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);

    migrate(database);

    expect(
      database
        .prepare(
          "SELECT name, `notnull` AS nullable_flag FROM pragma_table_info('project_runs') WHERE name = 'pause_reason'",
        )
        .get(),
    ).toEqual({ name: 'pause_reason', nullable_flag: 0 });
  });

  it('loads the built migration registry and applies every migration from a fresh production output', () => {
    const workspaceRoot = join(__dirname, '..', '..', '..', '..');
    const directory = mkdtempSync(
      join(workspaceRoot, '.mesh-session-platform-build-'),
    );
    const outputPath = join(directory, 'server');
    let database: Database | undefined;

    try {
      runProductionBuild(workspaceRoot, outputPath);
      const builtModule = createRequire(__filename)(
        join(outputPath, 'apps', 'server', 'src', 'db', 'migrate.js'),
      ) as { migrate: typeof migrate };
      database = openDatabase(join(directory, 'output.sqlite'));

      builtModule.migrate(database);

      expect(
        database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '001-initial' },
        { id: '002-command-state' },
        { id: '003-task-board-storage' },
        { id: '004-project-event-streams' },
        { id: '005-task-attempt-safety' },
        { id: '006-task-attempt-launch-recovery' },
        { id: '007-developer-execution' },
        { id: '008-developer-cycle-task-title' },
        { id: '009-qa-execution' },
        { id: '010-review-automation-state' },
        { id: '011-qa-interruption-repair' },
        { id: '012-project-runs' },
        { id: '013-task-attempt-project-run-source' },
        { id: '014-project-run-prelaunch-attention' },
        { id: '015-project-run-pause-reason' },
        { id: '016-project-run-automation-status' },
        { id: '017-pm-planning' },
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM pragma_table_info('processed_commands') ORDER BY cid",
          )
          .all(),
      ).toEqual([
        { name: 'id' },
        { name: 'idempotency_key' },
        { name: 'state' },
        { name: 'response_json' },
        { name: 'failure_json' },
        { name: 'created_at' },
        { name: 'updated_at' },
      ]);
    } finally {
      database?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }, 180_000);
});
