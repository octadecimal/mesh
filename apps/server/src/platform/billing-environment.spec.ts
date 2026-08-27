import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectBillingOverrides, loadServerConfig } from '../config.js';

describe('detectBillingOverrides', () => {
  it('reports API billing overrides without returning secret values', () => {
    expect(
      detectBillingOverrides({
        ANTHROPIC_API_KEY: 'secret-value-must-not-escape',
        UNRELATED_SETTING: 'present',
      }),
    ).toEqual([{ variable: 'ANTHROPIC_API_KEY' }]);
  });

  it('ignores an empty API key override', () => {
    expect(detectBillingOverrides({ ANTHROPIC_API_KEY: '' })).toEqual([]);
  });
});

describe('loadServerConfig', () => {
  it('keeps the server on loopback and resolves persistence outside the repository', () => {
    const baseDirectory = process.cwd();
    expect(
      loadServerConfig(
        { MESH_PORT: '4567', MESH_DATABASE_PATH: 'state/mesh.sqlite' },
        baseDirectory,
      ),
    ).toEqual({
      host: '127.0.0.1',
      port: 4567,
      baseDirectory,
      databasePath: join(
        homedir(),
        '.mesh-session-platform',
        'state',
        'mesh.sqlite',
      ),
      developmentOrigin: undefined,
      gitExecutable: undefined,
      projectRunMaxConcurrency: 4,
      webRoot: undefined,
    });
  });
});
