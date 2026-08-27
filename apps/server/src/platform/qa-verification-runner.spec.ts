import { describe, expect, it, vi } from 'vitest';

import type { ProcessRunner } from './process-runner.js';
import {
  QaVerificationCommandRejectedError,
  QaVerificationRunner,
} from './qa-verification-runner.js';

describe('QaVerificationRunner', () => {
  it('runs a direct verification executable without a shell', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '20 tests passed',
      stderr: '',
    }));
    const runner = new QaVerificationRunner({ run } as ProcessRunner);

    await expect(
      runner.run('C:\\repo', {
        executable: 'corepack',
        args: ['pnpm', 'test'],
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: '20 tests passed' });
    expect(run).toHaveBeenCalledWith(
      'corepack',
      ['pnpm', 'test'],
      expect.objectContaining({ cwd: 'C:\\repo' }),
    );
  });

  it.each([
    { executable: 'bash', args: ['-lc', 'echo owned > src/app.ts'] },
    {
      executable: 'node',
      args: ['-e', "require('fs').writeFileSync('src/app.ts','owned')"],
    },
    { executable: 'git', args: ['checkout', '--', 'src/app.ts'] },
    { executable: 'git', args: ['show', 'HEAD', '--output=src/app.ts'] },
    { executable: 'corepack', args: ['pnpm', 'exec', 'node', 'writer.js'] },
    {
      executable: 'corepack',
      args: ['pnpm', 'node', '-e', "require('fs').writeFileSync('owned','1')"],
    },
    { executable: 'npm', args: ['explore', 'dep', '--', 'cmd.exe'] },
    { executable: 'pnpm', args: ['run', 'rewrite-source'] },
  ])(
    'rejects source-authoring command authority: $executable $args',
    async (input) => {
      const run = vi.fn();
      const runner = new QaVerificationRunner({
        run,
      } as unknown as ProcessRunner);

      await expect(runner.run('C:\\repo', input)).rejects.toBeInstanceOf(
        QaVerificationCommandRejectedError,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('derives an opaque tracked-source state from Git rather than agent input', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'src/app.ts\0',
      stderr: '',
    }));
    const readTrackedFile = vi.fn(async () => Buffer.from('tracked source'));
    const runner = new QaVerificationRunner(
      { run } as ProcessRunner,
      readTrackedFile,
    );

    const first = await runner.captureTrackedSource('C:\\repo');
    const second = await runner.captureTrackedSource('C:\\repo');

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(run).toHaveBeenCalledWith(
      'git',
      ['-C', 'C:\\repo', 'ls-files', '-z'],
      expect.objectContaining({ cwd: 'C:\\repo' }),
    );
    expect(readTrackedFile).toHaveBeenCalledWith('C:\\repo\\src\\app.ts');
  });
});
