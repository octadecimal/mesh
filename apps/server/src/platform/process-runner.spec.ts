import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { NodeProcessRunner } from './process-runner.js';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
};

describe('NodeProcessRunner', () => {
  it('terminates the complete process tree owned by an aborted command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-process-tree-'));
    const grandchildPidPath = join(directory, 'grandchild.pid');
    let grandchildPid: number | undefined;
    try {
      const grandchild = [
        `require('node:fs').writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid))`,
        'setInterval(() => undefined, 1000)',
      ].join(';');
      const parent = [
        `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: process.platform === 'win32' })`,
        `if (process.platform === 'win32') child.unref()`,
        'setInterval(() => undefined, 1000)',
      ].join(';');
      const controller = new AbortController();
      const pending = new NodeProcessRunner().run(
        process.execPath,
        ['-e', parent],
        { cwd: directory, signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(existsSync(grandchildPidPath)).toBe(true));
      grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));

      controller.abort(new Error('controlled test cancellation'));
      await rejected;
      await vi.waitFor(() =>
        expect(grandchildPid && isAlive(grandchildPid)).toBe(false),
      );
    } finally {
      if (grandchildPid && isAlive(grandchildPid)) {
        const remainingPid = grandchildPid;
        process.kill(remainingPid);
        await vi.waitFor(() => expect(isAlive(remainingPid)).toBe(false));
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform === 'win32').each([
    ['corepack', ['pnpm', '--version']],
    ['pnpm', ['--version']],
    ['npm', ['--version']],
  ])(
    'runs the vetted Windows %s launcher without a shell',
    async (executable, args) => {
      const result = await new NodeProcessRunner().run(executable, args, {
        cwd: process.cwd(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  it('terminates a command when streamed output reaches its bound', async () => {
    await expect(
      new NodeProcessRunner().run(
        process.execPath,
        ['-e', `process.stdout.write('x'.repeat(64 * 1024))`],
        { cwd: process.cwd(), maxOutputBytes: 1_024 },
      ),
    ).rejects.toMatchObject({
      code: 'process_output_limit_exceeded',
      limit: 1_024,
      stream: 'stdout',
    });
  });
});
