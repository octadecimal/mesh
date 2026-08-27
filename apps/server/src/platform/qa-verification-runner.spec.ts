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
    {
      executable: 'npm',
      args: ['--prefix=C:\\other', 'test'],
    },
    {
      executable: 'npm',
      args: ['--prefix', 'C:\\other', 'test'],
    },
    {
      executable: 'git',
      args: ['--git-dir=C:\\other\\.git', 'show', 'HEAD:file'],
    },
    {
      executable: 'git',
      args: ['--work-tree=C:\\other', 'status'],
    },
    {
      executable: 'git',
      args: ['-c', 'core.pager=writer', 'show', 'HEAD:file'],
    },
    {
      executable: 'git',
      args: ['-ccore.pager=writer', 'show', 'HEAD:file'],
    },
    {
      executable: 'git',
      args: ['-CC:\\other', 'show', 'HEAD:file'],
    },
    {
      executable: 'pnpm',
      args: ['nx', 'test', 'server', '--', '-u'],
    },
    {
      executable: 'pnpm',
      args: ['test', '--', '--updateSnapshot'],
    },
    {
      executable: 'corepack',
      args: ['pnpm', 'test', '--', '--update-snapshots=all'],
    },
    {
      executable: 'pnpm',
      args: ['nx', 'test', 'server', '--outputFile=..\\outside.json'],
    },
    {
      executable: 'pnpm',
      args: ['test', 'C:\\other\\test.spec.ts'],
    },
    {
      executable: 'pnpm',
      args: ['test', 'C:..\\other\\test.spec.ts'],
    },
    {
      executable: 'pnpm',
      args: ['test', '--', '-uall'],
    },
    {
      executable: 'git',
      args: [
        'diff',
        '--no-index',
        'package.json',
        'src/../../other/secret.txt',
      ],
    },
    {
      executable: 'pnpm',
      args: ['test', '--', '--config=src/../../other/vitest.config.ts'],
    },
    {
      executable: 'pnpm',
      args: ['test', 'src\\..\\..\\other\\secret.spec.ts'],
    },
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

  it.each([
    {
      executable: 'git',
      args: [
        'diff',
        '--no-index',
        'package.json',
        'src/fixtures/expected.json',
      ],
    },
    {
      executable: 'pnpm',
      args: ['test', '--', '--config=src/config/vitest.config.ts'],
    },
  ])(
    'preserves workspace-local verification paths: $executable $args',
    async (input) => {
      const run = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
      }));
      const runner = new QaVerificationRunner({ run } as ProcessRunner);

      await expect(runner.run('C:\\repo', input)).resolves.toMatchObject({
        exitCode: 0,
      });
    },
  );

  it('resolves direct execution to the assigned workspace', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'passed',
      stderr: '',
    }));
    const runner = new QaVerificationRunner({ run } as ProcessRunner);

    await runner.run('C:\\repo\\nested\\..', {
      executable: 'pnpm',
      args: ['test'],
    });

    expect(run).toHaveBeenCalledWith(
      'pnpm',
      ['test'],
      expect.objectContaining({ cwd: 'C:\\repo' }),
    );
  });

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
      async () => ({
        dev: 1,
        ino: 1,
        mode: 0o100644,
        size: 14,
        mtimeNs: 0,
        ctimeNs: 0,
      }),
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

  it('detects a tracked mutation that occurs after the file was read', async () => {
    let sourceA = 'source-a-before';
    let sourceAVersion = 0;
    let mutateDuringRead = false;
    let mutated = false;
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'src/a.ts\0src/b.ts\0',
      stderr: '',
    }));
    const readTrackedFile = vi.fn(async (path: string) => {
      if (path.endsWith('a.ts')) return Buffer.from(sourceA);
      if (mutateDuringRead && !mutated) {
        sourceA = 'source-a-after!';
        sourceAVersion += 1;
        mutated = true;
      }
      return Buffer.from('source-b');
    });
    const statTrackedFile = vi.fn(async (path: string) => ({
      dev: 1,
      ino: path.endsWith('a.ts') ? 1 : 2,
      mode: 0o100644,
      size: path.endsWith('a.ts') ? sourceA.length : 8,
      mtimeNs: path.endsWith('a.ts') ? sourceAVersion : 0,
      ctimeNs: path.endsWith('a.ts') ? sourceAVersion : 0,
    }));
    const runner = new QaVerificationRunner(
      { run } as ProcessRunner,
      readTrackedFile,
      statTrackedFile,
    );
    const baseline = await runner.captureTrackedSource('C:\\repo');

    mutateDuringRead = true;
    const current = await runner.captureTrackedSource('C:\\repo');

    expect(current).not.toBe(baseline);
  });

  it('fails closed when tracked source never stabilizes', async () => {
    let sourceA = 'source-a-0';
    let sourceAVersion = 0;
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'src/a.ts\0src/b.ts\0',
      stderr: '',
    }));
    const readTrackedFile = vi.fn(async (path: string) => {
      if (path.endsWith('a.ts')) return Buffer.from(sourceA);
      sourceA = sourceA === 'source-a-0' ? 'source-a-1' : 'source-a-0';
      sourceAVersion += 1;
      return Buffer.from('source-b');
    });
    const statTrackedFile = vi.fn(async (path: string) => ({
      dev: 1,
      ino: path.endsWith('a.ts') ? 1 : 2,
      mode: 0o100644,
      size: path.endsWith('a.ts') ? sourceA.length : 8,
      mtimeNs: path.endsWith('a.ts') ? sourceAVersion : 0,
      ctimeNs: path.endsWith('a.ts') ? sourceAVersion : 0,
    }));
    const runner = new QaVerificationRunner(
      { run } as ProcessRunner,
      readTrackedFile,
      statTrackedFile,
    );

    await expect(runner.captureTrackedSource('C:\\repo')).rejects.toMatchObject(
      { code: 'qa_source_snapshot_unstable' },
    );
  });
});
