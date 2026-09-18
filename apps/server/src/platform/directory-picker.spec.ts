import { describe, expect, it } from 'vitest';

import { DirectoryPicker } from './directory-picker.js';

const filesystem = {
  realpath: async (path: string) => path,
  stat: async () => ({ isDirectory: () => true }),
};

describe('DirectoryPicker', () => {
  it('returns a canonical selection inside the configured workspace', async () => {
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
      runner: { run: async () => 'C:/workspace/project' },
    });

    await expect(picker.select()).resolves.toBe('C:/workspace/project');
  });

  it('rejects an escaped selection from the native dialog', async () => {
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
      runner: { run: async () => 'C:/outside' },
    });

    await expect(picker.select()).rejects.toMatchObject({
      code: 'directory_picker_invalid_path',
    });
  });

  it('allows a directory whose name begins with two dots', async () => {
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
      runner: { run: async () => 'C:/workspace/..cache' },
    });

    await expect(picker.select()).resolves.toBe('C:/workspace/..cache');
  });

  it('maps failed directory verification to the manual fallback error', async () => {
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: {
        ...filesystem,
        realpath: async () => {
          throw new Error('not available');
        },
      },
      runner: { run: async () => 'C:/workspace/project' },
    });

    await expect(picker.select()).rejects.toMatchObject({
      code: 'directory_picker_unavailable',
    });
  });

  it('reports unsupported platforms without attempting a dialog', async () => {
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'linux',
      fs: filesystem,
      runner: {
        run: async () => {
          throw new Error('unexpected');
        },
      },
    });

    await expect(picker.select()).rejects.toMatchObject({
      code: 'directory_picker_unavailable',
    });
  });

  it('allows only one native dialog at a time', async () => {
    let finish: ((value: string | null) => void) | undefined;
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
      runner: {
        run: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });

    const first = picker.select();
    await Promise.resolve();
    expect(() => picker.select()).toThrow('A folder picker is already open.');
    finish?.(null);
    await expect(first).resolves.toBeNull();
  });
});
