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

import {
  NodeProcessRunner,
  resolveGitExecutableAtStartup,
} from './process-runner.js';

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
  it('runs an explicitly approved custom Git installation outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-process-git-approved-'));
    const workspace = join(root, 'workspace');
    const install = join(root, 'portable');
    const git = join(install, process.platform === 'win32' ? 'git.exe' : 'git');
    const marker = join(root, 'approved-git-ran');
    try {
      mkdirSync(workspace);
      mkdirSync(install);
      copyFileSync(process.execPath, git);
      if (process.platform !== 'win32') chmodSync(git, 0o755);
      const approved = await resolveGitExecutableAtStartup({
        configuredPath: git,
        pathValue: '',
        platform: process.platform,
        workspaceRoot: workspace,
      });

      await new NodeProcessRunner({ trustedGitExecutable: approved }).run(
        'git',
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'approved')`,
        ],
        { cwd: workspace },
      );

      expect(readFileSync(marker, 'utf8')).toBe('approved');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('never runs a workspace-local Git executable found through PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-process-git-shadow-'));
    const directory = join(root, 'workspace');
    const install = join(root, 'portable');
    const localGit = join(
      directory,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    const approvedGit = join(
      install,
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    const payload = join(directory, 'payload.cjs');
    const marker = join(directory, 'workspace-git-ran');
    const priorPath = process.env.PATH;
    try {
      mkdirSync(directory);
      mkdirSync(install);
      copyFileSync(process.execPath, localGit);
      copyFileSync(process.execPath, approvedGit);
      if (process.platform !== 'win32') chmodSync(localGit, 0o755);
      if (process.platform !== 'win32') chmodSync(approvedGit, 0o755);
      writeFileSync(
        payload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.execPath)`,
      );
      process.env.PATH = `${directory}${delimiter}${priorPath ?? ''}`;
      const approved = await resolveGitExecutableAtStartup({
        configuredPath: approvedGit,
        pathValue: process.env.PATH,
        platform: process.platform,
        workspaceRoot: directory,
      });

      const result = await new NodeProcessRunner({
        trustedGitExecutable: approved,
      }).run('git', [payload, marker], { cwd: directory });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(
        approvedGit.toLowerCase(),
      );
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(root, { force: true, recursive: true });
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
      const runner = new NodeProcessRunner();

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

  it
    .runIf(process.platform === 'win32')
    .each(['D:\\ForgedWindows', '\\\\attacker.invalid\\share\\Windows'])(
    'does not derive Git trust from forged SystemRoot %s',
    async (systemRoot) => {
      const directory = mkdtempSync(join(tmpdir(), 'mesh-process-git-root-'));
      const payload = join(directory, 'payload.cjs');
      const marker = join(directory, 'forged-git-ran');
      const priorSystemRoot = process.env.SystemRoot;
      try {
        writeFileSync(
          payload,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
        );
        process.env.SystemRoot = systemRoot;

        await expect(
          new NodeProcessRunner().run('git', [payload], { cwd: directory }),
        ).rejects.toMatchObject({
          code: 'process_trusted_executable_unavailable',
        });

        expect(existsSync(marker)).toBe(false);
      } finally {
        if (priorSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = priorSystemRoot;
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it('enumerates only absolute startup PATH entries and skips workspace Git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-process-git-path-'));
    const workspace = join(root, 'workspace');
    const install = join(root, 'portable');
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    try {
      mkdirSync(workspace);
      mkdirSync(install);
      copyFileSync(process.execPath, join(workspace, name));
      copyFileSync(process.execPath, join(install, name));
      if (process.platform !== 'win32') {
        chmodSync(join(workspace, name), 0o755);
        chmodSync(join(install, name), 0o755);
      }

      const approved = await resolveGitExecutableAtStartup({
        pathValue: ['', 'relative-bin', workspace, install].join(delimiter),
        platform: process.platform,
        workspaceRoot: workspace,
      });

      expect(approved?.path.toLowerCase()).toBe(
        join(install, name).toLowerCase(),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('fails closed for relative, missing, and workspace-contained configured Git paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-process-git-invalid-'));
    const workspace = join(root, 'workspace');
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    try {
      mkdirSync(workspace);
      const insideGit = join(workspace, name);
      copyFileSync(process.execPath, insideGit);
      if (process.platform !== 'win32') chmodSync(insideGit, 0o755);

      for (const configuredPath of [
        join('relative', name),
        join(root, 'missing', name),
        insideGit,
      ]) {
        await expect(
          resolveGitExecutableAtStartup({
            configuredPath,
            pathValue: process.env.PATH,
            platform: process.platform,
            workspaceRoot: workspace,
          }),
        ).resolves.toBeUndefined();
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('revalidates the approved Git file identity before every launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-process-git-replaced-'));
    const workspace = join(root, 'workspace');
    const install = join(root, 'portable');
    const git = join(install, process.platform === 'win32' ? 'git.exe' : 'git');
    const marker = join(root, 'replacement-ran');
    try {
      mkdirSync(workspace);
      mkdirSync(install);
      copyFileSync(process.execPath, git);
      if (process.platform !== 'win32') chmodSync(git, 0o755);
      const approved = await resolveGitExecutableAtStartup({
        configuredPath: git,
        workspaceRoot: workspace,
      });
      rmSync(git);
      writeFileSync(git, 'replacement executable');
      if (process.platform !== 'win32') chmodSync(git, 0o755);

      await expect(
        new NodeProcessRunner({ trustedGitExecutable: approved }).run(
          'git',
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
          ],
          { cwd: workspace },
        ),
      ).rejects.toMatchObject({
        code: 'process_trusted_executable_unavailable',
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
