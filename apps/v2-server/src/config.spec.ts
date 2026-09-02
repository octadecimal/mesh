import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadV2ServerConfig, V2ConfigError } from './config';
import { approveV2GitExecutable } from './platform/process-runner';

const root = resolve('C:/work/mesh');

describe('loadV2ServerConfig', () => {
  it('uses a distinct V2 port and database namespace', () => {
    const config = loadV2ServerConfig({}, root);

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3838,
      workspaceRoot: root,
      databasePath: join(root, '.mesh', 'v2', 'mesh-v2.sqlite'),
    });
  });

  it('allows port zero only for the fake-only test process', () => {
    expect(
      loadV2ServerConfig({ NODE_ENV: 'test', MESH_V2_PORT: '0' }, root).port,
    ).toBe(0);
    expect(() =>
      loadV2ServerConfig({ NODE_ENV: 'production', MESH_V2_PORT: '0' }, root),
    ).toThrowError(
      expect.objectContaining<V2ConfigError>({ code: 'invalid_v2_port' }),
    );
  });

  it('defaults the development web origin only in development', () => {
    expect(
      loadV2ServerConfig({ NODE_ENV: 'development' }, root).developmentOrigin,
    ).toBe('http://127.0.0.1:4300');
    expect(
      loadV2ServerConfig({ NODE_ENV: 'production' }, root).developmentOrigin,
    ).toBeUndefined();
    expect(
      loadV2ServerConfig({ NODE_ENV: 'test' }, root).developmentOrigin,
    ).toBeUndefined();
  });

  it('prefers an explicit valid loopback development origin', () => {
    expect(
      loadV2ServerConfig(
        {
          NODE_ENV: 'development',
          MESH_V2_DEV_ORIGIN: 'http://127.0.0.1:4400',
        },
        root,
      ).developmentOrigin,
    ).toBe('http://127.0.0.1:4400');
  });

  it.each(['0.0.0.0', 'localhost', 'example.com'])(
    'rejects non-loopback host %s',
    (host) => {
      expect(() =>
        loadV2ServerConfig({ MESH_V2_HOST: host }, root),
      ).toThrowError(
        expect.objectContaining<V2ConfigError>({ code: 'invalid_v2_host' }),
      );
    },
  );

  it('accepts only absolute path overrides', () => {
    expect(() =>
      loadV2ServerConfig({ MESH_V2_DATABASE_PATH: 'relative.sqlite' }, root),
    ).toThrowError(
      expect.objectContaining<V2ConfigError>({ code: 'invalid_v2_path' }),
    );
    expect(() =>
      loadV2ServerConfig({ MESH_V2_WEB_ROOT: './dist' }, root),
    ).toThrowError(
      expect.objectContaining<V2ConfigError>({ code: 'invalid_v2_path' }),
    );
  });

  it('accepts the fake cursor hold only in tests', () => {
    expect(
      loadV2ServerConfig(
        { NODE_ENV: 'test', MESH_V2_FAKE_HOLD_AFTER_CURSOR: '2' },
        root,
      ).testFakeHoldAfterAdapterCursor,
    ).toBe(2);
    expect(() =>
      loadV2ServerConfig(
        {
          NODE_ENV: 'production',
          MESH_V2_FAKE_HOLD_AFTER_CURSOR: '2',
        },
        root,
      ),
    ).toThrowError(
      expect.objectContaining<V2ConfigError>({
        code: 'invalid_v2_test_option',
      }),
    );
  });

  it('accepts the Todo fake PM scenario only in tests and omits it by default', () => {
    expect(loadV2ServerConfig({}, root).testFakePmScenario).toBeUndefined();
    expect(
      loadV2ServerConfig(
        { NODE_ENV: 'test', MESH_V2_TEST_FAKE_PM_SCENARIO: 'todo' },
        root,
      ).testFakePmScenario,
    ).toBe('todo');
    for (const NODE_ENV of [undefined, 'production']) {
      expect(() =>
        loadV2ServerConfig(
          { NODE_ENV, MESH_V2_TEST_FAKE_PM_SCENARIO: 'todo' },
          root,
        ),
      ).toThrowError(
        expect.objectContaining<V2ConfigError>({
          code: 'invalid_v2_test_option',
        }),
      );
    }
  });

  it.each(['malformed', 'duplicate', 'missing_output', 'unknown'])(
    'rejects unsupported fake PM scenario %s',
    (scenario) => {
      expect(() =>
        loadV2ServerConfig(
          { NODE_ENV: 'test', MESH_V2_TEST_FAKE_PM_SCENARIO: scenario },
          root,
        ),
      ).toThrowError(
        expect.objectContaining<V2ConfigError>({
          code: 'invalid_v2_test_option',
        }),
      );
    },
  );

  it.each(['completed', 'blocked', 'malformed', 'duplicate', 'missing_output'])(
    'accepts the %s fake Developer scenario only in tests',
    (scenario) => {
      expect(
        loadV2ServerConfig(
          { NODE_ENV: 'test', MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO: scenario },
          root,
        ).testFakeDeveloperScenario,
      ).toBe(scenario);
      expect(() =>
        loadV2ServerConfig(
          {
            NODE_ENV: 'production',
            MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO: scenario,
          },
          root,
        ),
      ).toThrowError(
        expect.objectContaining<V2ConfigError>({
          code: 'invalid_v2_test_option',
        }),
      );
    },
  );

  it('rejects unsupported fake Developer scenarios', () => {
    expect(() =>
      loadV2ServerConfig(
        { NODE_ENV: 'test', MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO: 'unknown' },
        root,
      ),
    ).toThrowError(
      expect.objectContaining<V2ConfigError>({
        code: 'invalid_v2_test_option',
      }),
    );
  });

  it.each(['https://example.com', 'http://localhost:4300'])(
    'rejects non-loopback development origin %s',
    (origin) => {
      expect(() =>
        loadV2ServerConfig({ MESH_V2_DEV_ORIGIN: origin }, root),
      ).toThrowError(
        expect.objectContaining<V2ConfigError>({ code: 'invalid_v2_origin' }),
      );
    },
  );

  it('does not read similarly named V1 settings', () => {
    const config = loadV2ServerConfig(
      {
        HOST: '0.0.0.0',
        PORT: '3737',
        MESH_DATABASE_PATH: 'v1.sqlite',
      },
      root,
    );

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3838);
    expect(config.databasePath).toBe(
      join(root, '.mesh', 'v2', 'mesh-v2.sqlite'),
    );
  });
});

describe('V2 Git executable approval', () => {
  it('approves one absolute executable outside the workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-v2-git-test-'));
    const workspace = join(directory, 'workspace');
    const executable = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    mkdirSync(workspace);
    writeFileSync(executable, 'test');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    try {
      await expect(
        approveV2GitExecutable({
          configuredPath: executable,
          workspaceRoot: workspace,
        }),
      ).resolves.toMatchObject({ path: resolve(executable) });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('does not accept a relative or workspace-controlled Git executable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-v2-git-test-'));
    const executable = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    writeFileSync(executable, 'test');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    try {
      await expect(
        approveV2GitExecutable({
          configuredPath: 'git',
          workspaceRoot: directory,
        }),
      ).rejects.toMatchObject({ code: 'git_executable_unavailable' });
      await expect(
        approveV2GitExecutable({
          configuredPath: executable,
          workspaceRoot: directory,
        }),
      ).rejects.toMatchObject({ code: 'git_executable_unavailable' });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
