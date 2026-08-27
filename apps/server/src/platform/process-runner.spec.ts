import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
  it('never runs a workspace-local Git executable found through PATH', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-process-git-shadow-'));
    const localGit = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    const payload = join(directory, 'payload.cjs');
    const marker = join(directory, 'workspace-git-ran');
    const priorPath = process.env.PATH;
    try {
      copyFileSync(process.execPath, localGit);
      if (process.platform !== 'win32') chmodSync(localGit, 0o755);
      writeFileSync(
        payload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
      );
      process.env.PATH = `${directory}${delimiter}${priorPath ?? ''}`;

      const result = await new NodeProcessRunner().run(
        'git',
        [payload, marker],
        { cwd: directory },
      );

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('refuses Git before launch when no trusted installation is available', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-process-git-missing-'));
    const localGit = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    const payload = join(directory, 'payload.cjs');
    const marker = join(directory, 'started');
    const priorPath = process.env.PATH;
    try {
      copyFileSync(process.execPath, localGit);
      if (process.platform !== 'win32') chmodSync(localGit, 0o755);
      writeFileSync(
        payload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
      );
      process.env.PATH = `${directory}${delimiter}${priorPath ?? ''}`;
      const runner = new NodeProcessRunner({
        resolveTrustedGitExecutable: async () => undefined,
      });

      await expect(
        runner.run('git', [payload], { cwd: directory }),
      ).rejects.toMatchObject({
        code: 'process_trusted_executable_unavailable',
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'does not trust forged Windows installation-root variables',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mesh-process-git-root-'));
      const forgedRoot = mkdtempSync(
        join(tmpdir(), 'mesh-process-git-forged-'),
      );
      const forgedGitDirectory = join(forgedRoot, 'Git', 'cmd');
      const payload = join(directory, 'payload.cjs');
      const marker = join(directory, 'forged-git-ran');
      const prior = {
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        ProgramFiles: process.env.ProgramFiles,
        ProgramFilesX86: process.env['ProgramFiles(x86)'],
        ProgramW6432: process.env.ProgramW6432,
      };
      try {
        mkdirSync(forgedGitDirectory, { recursive: true });
        copyFileSync(process.execPath, join(forgedGitDirectory, 'git.exe'));
        writeFileSync(
          payload,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
        );
        process.env.LOCALAPPDATA = forgedRoot;
        process.env.ProgramFiles = forgedRoot;
        process.env['ProgramFiles(x86)'] = forgedRoot;
        process.env.ProgramW6432 = forgedRoot;

        const result = await new NodeProcessRunner().run('git', [payload], {
          cwd: directory,
        });

        expect(result.exitCode).not.toBe(0);
        expect(existsSync(marker)).toBe(false);
      } finally {
        for (const [name, value] of Object.entries({
          LOCALAPPDATA: prior.LOCALAPPDATA,
          ProgramFiles: prior.ProgramFiles,
          'ProgramFiles(x86)': prior.ProgramFilesX86,
          ProgramW6432: prior.ProgramW6432,
        })) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        rmSync(directory, { force: true, recursive: true });
        rmSync(forgedRoot, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform === 'win32').each(['corepack', 'pnpm', 'npm'])(
    'never runs a workspace-local %s executable found through PATH',
    async (executable) => {
      const directory = mkdtempSync(
        join(tmpdir(), `mesh-process-${executable}-shadow-`),
      );
      const payload = join(directory, 'payload.cjs');
      const marker = join(directory, `${executable}-ran`);
      const priorPath = process.env.PATH;
      try {
        copyFileSync(process.execPath, join(directory, `${executable}.exe`));
        writeFileSync(
          payload,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
        );
        process.env.PATH = `${directory}${delimiter}${priorPath ?? ''}`;

        await new NodeProcessRunner().run(executable, [payload], {
          cwd: directory,
        });

        expect(existsSync(marker)).toBe(false);
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it.each([
    {
      name: 'is unavailable',
      resolveWindowsTreeTerminator: async () => undefined,
      runWindowsTreeTerminator: async () => 0,
    },
    {
      name: 'cannot spawn',
      resolveWindowsTreeTerminator: async () => 'trusted-taskkill.exe',
      runWindowsTreeTerminator: async () => {
        throw new Error('controlled taskkill spawn failure');
      },
    },
    {
      name: 'returns nonzero',
      resolveWindowsTreeTerminator: async () => 'trusted-taskkill.exe',
      runWindowsTreeTerminator: async () => 1,
    },
  ])(
    'refuses to launch a Windows command when the owned tree terminator $name',
    async ({ resolveWindowsTreeTerminator, runWindowsTreeTerminator }) => {
      const directory = mkdtempSync(join(tmpdir(), 'mesh-process-preflight-'));
      const marker = join(directory, 'started');
      try {
        const runner = new NodeProcessRunner({
          platform: 'win32',
          resolveWindowsTreeTerminator,
          runWindowsTreeTerminator,
        });

        await expect(
          runner.run(
            process.execPath,
            [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
            ],
            { cwd: directory },
          ),
        ).rejects.toMatchObject({ code: 'process_termination_unavailable' });
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

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

  it.each(['nonzero', 'deadline'] as const)(
    'rejects promptly and kills the exact child when Windows tree termination fails by %s',
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), 'mesh-process-failure-'));
      const childPidPath = join(directory, 'child.pid');
      let childPid: number | undefined;
      let terminatorCalls = 0;
      try {
        const runner = new NodeProcessRunner({
          platform: 'win32',
          resolveWindowsTreeTerminator: async () => 'trusted-taskkill.exe',
          runWindowsTreeTerminator: async () => {
            terminatorCalls += 1;
            if (terminatorCalls === 1) return 0;
            if (failure === 'nonzero') return 1;
            return new Promise<number>(() => undefined);
          },
          terminationDeadlineMs: 25,
        });
        const controller = new AbortController();
        const pending = runner.run(
          process.execPath,
          [
            '-e',
            [
              `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid))`,
              'setInterval(() => undefined, 1000)',
            ].join(';'),
          ],
          { cwd: directory, signal: controller.signal },
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: 'process_termination_failed',
        });
        await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true));
        childPid = Number(readFileSync(childPidPath, 'utf8'));

        controller.abort(new Error('controlled cancellation'));
        await rejected;
        await vi.waitFor(() =>
          expect(childPid && isAlive(childPid)).toBe(false),
        );
      } finally {
        if (childPid && isAlive(childPid)) process.kill(childPid);
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

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
        [
          '-e',
          `process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => undefined, 1000)`,
        ],
        { cwd: process.cwd(), maxOutputBytes: 1_024 },
      ),
    ).rejects.toMatchObject({
      code: 'process_output_limit_exceeded',
      limit: 1_024,
      stream: 'stdout',
    });
  });
});
