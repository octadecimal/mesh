import { describe, expect, it } from 'vitest';

import { loadServerConfig } from './config.js';

describe('server configuration', () => {
  it('defaults project run concurrency to the server maximum', () => {
    expect(loadServerConfig({}).projectRunMaxConcurrency).toBe(4);
  });

  it('reads an explicit positive project run concurrency maximum', () => {
    expect(
      loadServerConfig({ MESH_PROJECT_RUN_MAX_CONCURRENCY: ' 2 ' })
        .projectRunMaxConcurrency,
    ).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects an invalid project run concurrency maximum of %s',
    (value) => {
      expect(() =>
        loadServerConfig({ MESH_PROJECT_RUN_MAX_CONCURRENCY: value }),
      ).toThrow('MESH_PROJECT_RUN_MAX_CONCURRENCY must be a positive integer');
    },
  );
});
