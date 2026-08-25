import { win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveWorkspacePath, type WorkspacePathFileSystem } from './paths.js';

const win32TestFs = (): WorkspacePathFileSystem => ({
  realpath: async (value) => win32.normalize(value),
  stat: async () => ({ isDirectory: () => true }),
});

describe('resolveWorkspacePath', () => {
  it.each([
    ['C:\\repo\\..\\repo\\src', 'C:\\repo\\src'],
    ['C:/repo/src', 'C:\\repo\\src'],
  ])('normalizes a Windows workspace path: %s', async (input, expected) => {
    await expect(
      resolveWorkspacePath(input, {
        baseDirectory: 'C:\\repo',
        fs: win32TestFs(),
        path: win32,
      }),
    ).resolves.toBe(expected);
  });

  it('resolves a relative workspace path from the injected base directory', async () => {
    await expect(
      resolveWorkspacePath('packages/app', {
        baseDirectory: 'C:\\repo',
        fs: win32TestFs(),
        path: win32,
      }),
    ).resolves.toBe('C:\\repo\\packages\\app');
  });

  it('rejects a path with a NUL byte before filesystem access', async () => {
    await expect(
      resolveWorkspacePath('C:\\repo\\bad\0path', {
        baseDirectory: 'C:\\repo',
        fs: win32TestFs(),
        path: win32,
      }),
    ).rejects.toThrow('NUL');
  });

  it('rejects an existing path that is not a directory', async () => {
    const fs: WorkspacePathFileSystem = {
      realpath: async (value) => value,
      stat: async () => ({ isDirectory: () => false }),
    };

    await expect(
      resolveWorkspacePath('C:\\repo\\file.txt', {
        baseDirectory: 'C:\\repo',
        fs,
        path: win32,
      }),
    ).rejects.toThrow('directory');
  });
});
