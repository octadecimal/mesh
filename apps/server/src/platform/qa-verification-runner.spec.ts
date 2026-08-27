import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ProcessRunner } from './process-runner.js';
import {
  QaVerificationCommandRejectedError,
  QaVerificationRunner,
} from './qa-verification-runner.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
    { executable: 'pnpm', args: ['test', '--watch'] },
    { executable: 'pnpm', args: ['test', '--watchAll'] },
    { executable: 'pnpm', args: ['test', '--ui'] },
    { executable: 'pnpm', args: ['run', 'test:watch'] },
    { executable: 'pnpm', args: ['nx', 'test', 'server', '--watch=true'] },
    { executable: 'npm', args: ['start'] },
    { executable: 'pnpm', args: ['test', '--root=../../outside'] },
    {
      executable: 'pnpm',
      args: ['test', '--coverage.reportsDirectory=../../outside'],
    },
    { executable: 'pnpm', args: ['run', 'test:server'] },
    { executable: 'pnpm', args: ['run', 'test-server'] },
    { executable: 'pnpm', args: ['run', 'test.server'] },
    { executable: 'pnpm', args: ['run', 'test_server'] },
    { executable: 'pnpm', args: ['run', 'test-watch'] },
    { executable: 'pnpm', args: ['run', 'test.watch'] },
    { executable: 'pnpm', args: ['run', 'test_watch'] },
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
    {
      executable: 'pnpm',
      args: ['test', '--', '--testNamePattern=/workspace behavior/'],
    },
    {
      executable: 'pnpm',
      args: ['test', '--', '--testNamePattern', '/workspace behavior/'],
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

  it('cancels an owned verification child when its QA runtime is interrupted', async () => {
    const started = deferred();
    let activeChildren = 0;
    const run = vi.fn(
      async (
        _executable: string,
        _args: readonly string[],
        options: { signal?: AbortSignal },
      ) => {
        started.resolve();
        if (!options.signal) {
          return { exitCode: 0, stdout: 'not cancellable', stderr: '' };
        }
        activeChildren += 1;
        return new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              activeChildren -= 1;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    );
    const runner = new QaVerificationRunner({ run } as ProcessRunner);
    const controller = new AbortController();

    const pending = runner.run(
      'C:\\repo',
      { executable: 'pnpm', args: ['test'] },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'qa_verification_cancelled',
    });
    expect(activeChildren).toBe(0);
  });

  it('times out an owned verification child and leaves no active process', async () => {
    vi.useFakeTimers();
    try {
      const started = deferred();
      let activeChildren = 0;
      const run = vi.fn(
        async (
          _executable: string,
          _args: readonly string[],
          options: { signal?: AbortSignal },
        ) => {
          started.resolve();
          if (!options.signal) {
            return { exitCode: 0, stdout: 'not bounded', stderr: '' };
          }
          activeChildren += 1;
          return new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                activeChildren -= 1;
                reject(options.signal?.reason);
              },
              { once: true },
            );
          });
        },
      );
      const runner = new QaVerificationRunner(
        { run } as ProcessRunner,
        undefined,
        undefined,
        { verificationTimeoutMs: 100 },
      );

      const pending = runner.run('C:\\repo', {
        executable: 'pnpm',
        args: ['test'],
      });
      const timedOut = expect(pending).rejects.toMatchObject({
        code: 'qa_verification_timed_out',
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(100);

      await timedOut;
      expect(activeChildren).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps streamed output overflow to a stable QA verification failure', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('output limit exceeded'), {
        code: 'process_output_limit_exceeded',
        limit: 64_000,
        stream: 'stdout',
      });
    });
    const runner = new QaVerificationRunner({ run } as ProcessRunner);

    await expect(
      runner.run('C:\\repo', { executable: 'pnpm', args: ['test'] }),
    ).rejects.toMatchObject({
      code: 'qa_verification_output_limit_exceeded',
    });
    expect(run).toHaveBeenCalledWith(
      'pnpm',
      ['test'],
      expect.objectContaining({ maxOutputBytes: 64_000 }),
    );
  });

  it('rejects a test config reached through an external directory link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-verifier-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-verifier-outside-'));
    try {
      writeFileSync(join(outside, 'vitest.config.ts'), 'export default {}');
      symlinkSync(
        outside,
        join(root, 'external'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const run = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
      }));
      const runner = new QaVerificationRunner({ run } as ProcessRunner);

      await expect(
        runner.run(root, {
          executable: 'pnpm',
          args: ['test', '--', '--config=external/vitest.config.ts'],
        }),
      ).rejects.toBeInstanceOf(QaVerificationCommandRejectedError);
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a missing config beneath an external directory link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-verifier-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-verifier-outside-'));
    try {
      symlinkSync(
        outside,
        join(root, 'external'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const run = vi.fn();
      const runner = new QaVerificationRunner({ run } as ProcessRunner);

      await expect(
        runner.run(root, {
          executable: 'pnpm',
          args: ['test', '--', '--config=external/missing/vitest.config.ts'],
        }),
      ).rejects.toBeInstanceOf(QaVerificationCommandRejectedError);
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
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

  it('hashes a tracked directory link without reading its external target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-source-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-source-outside-'));
    try {
      const secret = join(outside, 'secret.txt');
      writeFileSync(secret, 'first external value');
      symlinkSync(
        outside,
        join(root, 'tracked-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const run = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'tracked-link\0',
        stderr: '',
      }));
      const runner = new QaVerificationRunner({ run } as ProcessRunner);

      const first = await runner.captureTrackedSource(root);
      writeFileSync(secret, 'changed external value');
      const second = await runner.captureTrackedSource(root);

      expect(second).toBe(first);
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects an indexed link object reached through an external parent junction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-source-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-source-outside-'));
    const target = mkdtempSync(join(tmpdir(), 'mesh-qa-source-target-'));
    try {
      symlinkSync(
        outside,
        join(root, 'external-parent'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      symlinkSync(
        target,
        join(outside, 'tracked-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const run = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'external-parent/tracked-link\0',
        stderr: '',
      }));
      const runner = new QaVerificationRunner({ run } as ProcessRunner);

      await expect(runner.captureTrackedSource(root)).rejects.toThrow(
        'Tracked source path escaped the verified workspace.',
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
      rmSync(target, { force: true, recursive: true });
    }
  });

  it('fails closed when a tracked link disappears during an observation', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'tracked-link\0',
      stderr: '',
    }));
    let readCount = 0;
    const readTrackedLink = vi.fn(async () => {
      readCount += 1;
      if (readCount % 2 === 1) return 'C:\\outside';
      throw Object.assign(new Error('link disappeared'), { code: 'ENOENT' });
    });
    const runner = new QaVerificationRunner(
      { run } as ProcessRunner,
      async () => Buffer.from('must not be read'),
      async () => ({
        dev: 1,
        ino: 1,
        mode: 0o120777,
        size: 10,
        mtimeNs: 0,
        ctimeNs: 0,
        isSymbolicLink: () => true,
      }),
      { readTrackedLink },
    );

    await expect(runner.captureTrackedSource('C:\\repo')).rejects.toMatchObject(
      { code: 'qa_source_snapshot_unstable' },
    );
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
