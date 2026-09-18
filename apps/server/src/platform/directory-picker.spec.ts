import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { DirectoryPicker } from './directory-picker.js';

const filesystem = {
  realpath: async (path: string) => path,
  stat: async () => ({ isDirectory: () => true }),
};

const createChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
};

describe('DirectoryPicker', () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it('runs the hidden modern folder dialog and decodes a UTF-8 selection', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
    });

    const selected = picker.select();
    await Promise.resolve();
    child.stdout.emit('data', Buffer.from('C:/workspace/東京'));
    child.emit('close', 0);

    await expect(selected).resolves.toBe('C:/workspace/東京');
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', expect.any(String)],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        env: expect.objectContaining({
          MESH_DIRECTORY_PICKER_ROOT: 'C:/workspace',
        }),
      }),
    );
    const powershellScript = spawnMock.mock.calls[0]?.[1]?.[4];
    expect(powershellScript).toEqual(
      expect.stringContaining("$ErrorActionPreference = 'Stop'"),
    );
    expect(powershellScript).toEqual(expect.stringContaining('IFileDialog'));
    expect(powershellScript).toEqual(expect.stringContaining('PickFolders'));
    expect(powershellScript).toEqual(expect.stringContaining('SetFolder'));
    expect(powershellScript).toEqual(
      expect.stringContaining('$owner.TopMost = $true'),
    );
  });

  it('returns null when the native dialog is cancelled', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
    });

    const selected = picker.select();
    await Promise.resolve();
    child.emit('close', 0);

    await expect(selected).resolves.toBeNull();
  });

  it('reports native dialog setup failures', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
    });

    const selected = picker.select();
    await Promise.resolve();
    child.emit('close', 1);

    await expect(selected).rejects.toMatchObject({
      code: 'directory_picker_unavailable',
    });
  });

  it('kills a native dialog that exceeds the timeout', async () => {
    vi.useFakeTimers();
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const picker = new DirectoryPicker({
      workspaceRoot: 'C:/workspace',
      platform: 'win32',
      fs: filesystem,
    });

    const selected = picker.select();
    const rejected = expect(selected).rejects.toThrow(
      'The folder picker timed out.',
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);

    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });

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
