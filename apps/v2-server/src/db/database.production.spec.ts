import { execFileSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { V2Database } from './database.js';

const workspaceRoot = resolve(__dirname, '..', '..', '..', '..');
const temporaryRoot = mkdtempSync(join(workspaceRoot, '.mesh-v2-build-test-'));
const builtRoot = join(temporaryRoot, 'server');

const runProductionV2Build = () => {
  const buildEnvironment = { ...process.env };
  for (const name of Object.keys(buildEnvironment)) {
    if (name.startsWith('NX_')) delete buildEnvironment[name];
  }
  const pnpmArgs = [
    'nx',
    'build',
    'v2-server',
    '--configuration=production',
    '--skip-nx-cache',
    `--outputPath=${relative(workspaceRoot, builtRoot).replace(/\\/g, '/')}`,
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
    const pnpmShim = join(temporaryRoot, 'pnpm.cmd');
    writeFileSync(
      pnpmShim,
      `@echo off\r\n"${process.execPath}" "${npmExecPath}" %*\r\n`,
    );
    execFileSync(process.execPath, [npmExecPath, ...pnpmArgs], {
      ...options,
      env: {
        ...options.env,
        PATH: `${temporaryRoot}${delimiter}${options.env.PATH ?? ''}`,
        npm_execpath: npmExecPath,
      },
    });
  }
};

beforeAll(runProductionV2Build, 180_000);

afterAll(() => {
  const relativeTemporary = relative(workspaceRoot, temporaryRoot);
  if (
    relativeTemporary.startsWith('..') ||
    relativeTemporary === '' ||
    !temporaryRoot.includes('.mesh-v2-build-test-')
  ) {
    throw new Error('Refusing to remove an unverified build-test directory');
  }
  rmSync(temporaryRoot, { force: true, recursive: true });
});

it('opens a fresh identified database through emitted JavaScript and packaged SQL', () => {
  const builtDatabase = join(builtRoot, 'db', 'database.js');
  expect(existsSync(builtDatabase)).toBe(true);
  expect(
    existsSync(join(builtRoot, 'db', 'migrations', '001_foundation.sql')),
  ).toBe(true);
  expect(existsSync(join(builtRoot, 'migrations', '001_foundation.sql'))).toBe(
    true,
  );
  expect(
    existsSync(join(builtRoot, 'db', 'migrations', '003_planning_board.sql')),
  ).toBe(true);
  expect(
    existsSync(
      join(builtRoot, 'db', 'migrations', '004_developer_attempts.sql'),
    ),
  ).toBe(true);
  expect(
    existsSync(
      join(builtRoot, 'db', 'migrations', '005_developer_attempt_commands.sql'),
    ),
  ).toBe(true);
  expect(
    existsSync(
      join(
        builtRoot,
        'db',
        'migrations',
        '006_developer_start_reservations.sql',
      ),
    ),
  ).toBe(true);
  expect(
    existsSync(join(builtRoot, 'migrations', '003_planning_board.sql')),
  ).toBe(true);
  expect(
    existsSync(join(builtRoot, 'migrations', '004_developer_attempts.sql')),
  ).toBe(true);
  expect(
    existsSync(
      join(builtRoot, 'migrations', '005_developer_attempt_commands.sql'),
    ),
  ).toBe(true);
  expect(
    existsSync(
      join(builtRoot, 'migrations', '006_developer_start_reservations.sql'),
    ),
  ).toBe(true);

  const built = createRequire(__filename)(builtDatabase) as {
    openV2Database(path: string): V2Database;
  };
  const database = built.openV2Database(join(temporaryRoot, 'built.sqlite'));
  try {
    expect(database.pragma('application_id', { simple: true })).toBe(
      1_297_494_528,
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'worker_executions'",
        )
        .get(),
    ).toEqual({ name: 'worker_executions' });
    expect(
      database
        .prepare(
          'SELECT version, name FROM v2_schema_migrations ORDER BY version',
        )
        .all(),
    ).toEqual([
      { version: 1, name: '001_foundation' },
      { version: 2, name: '002_intent_ledger' },
      { version: 3, name: '003_planning_board' },
      { version: 4, name: '004_developer_attempts' },
      { version: 5, name: '005_developer_attempt_commands' },
      { version: 6, name: '006_developer_start_reservations' },
    ]);
  } finally {
    database.close();
  }
});
