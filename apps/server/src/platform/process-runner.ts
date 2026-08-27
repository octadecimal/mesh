import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const defaultMaxOutputBytes = 16 * 1024 * 1024;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunOptions = {
  cwd: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult>;
}

export class ProcessOutputLimitError extends Error {
  readonly code = 'process_output_limit_exceeded';

  constructor(
    readonly stream: 'stderr' | 'stdout',
    readonly limit: number,
  ) {
    super(`Process ${stream} exceeded the ${limit}-byte output limit.`);
    this.name = 'ProcessOutputLimitError';
  }
}

const inside = (root: string, candidate: string) => {
  const child = relative(root, candidate);
  return (
    child !== '..' &&
    !child.startsWith('../') &&
    !child.startsWith('..\\') &&
    !isAbsolute(child)
  );
};

const trustedWindowsLauncher = async (
  executable: string,
  args: readonly string[],
): Promise<{ executable: string; args: readonly string[] }> => {
  if (process.platform !== 'win32') return { executable, args };
  const name = executable.replace(/\.cmd$/i, '').toLowerCase();
  const relativeEntry =
    name === 'corepack'
      ? ['node_modules', 'corepack', 'dist', 'corepack.js']
      : name === 'pnpm'
        ? ['node_modules', 'corepack', 'dist', 'pnpm.js']
        : name === 'npm'
          ? ['node_modules', 'npm', 'bin', 'npm-cli.js']
          : undefined;
  if (!relativeEntry) return { executable, args };

  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = dirname(nodeExecutable);
  const entry = await realpath(join(nodeRoot, ...relativeEntry));
  const entryStat = await lstat(entry);
  if (!inside(nodeRoot, entry) || !entryStat.isFile()) {
    throw new Error(`Trusted ${name} launcher is unavailable.`);
  }
  return { executable: nodeExecutable, args: [entry, ...args] };
};

const windowsTaskkillPath = async (): Promise<string | undefined> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return undefined;
  try {
    const canonicalRoot = await realpath(resolve(systemRoot));
    const taskkill = await realpath(
      join(canonicalRoot, 'System32', 'taskkill.exe'),
    );
    const taskkillStat = await lstat(taskkill);
    return inside(canonicalRoot, taskkill) && taskkillStat.isFile()
      ? taskkill
      : undefined;
  } catch {
    return undefined;
  }
};

const runTaskkill = async (pid: number): Promise<void> => {
  const taskkill = await windowsTaskkillPath();
  if (!taskkill) return;
  await new Promise<void>((done) => {
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => done());
    killer.once('close', () => done());
  });
};

const terminateOwnedTree = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    await runTaskkill(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await new Promise((done) => setTimeout(done, 250));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The owned group already exited.
  }
};

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('The operation was aborted.'), {
        code: 'ABORT_ERR',
        name: 'AbortError',
      });

export class NodeProcessRunner implements ProcessRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    if (options.signal?.aborted) throw abortError(options.signal);
    const launch = await trustedWindowsLauncher(executable, args);
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error('Process output limit must be a positive safe integer.');
    }

    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(launch.executable, [...launch.args], {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
      const output: Record<'stderr' | 'stdout', Buffer[]> = {
        stderr: [],
        stdout: [],
      };
      const outputBytes = { stderr: 0, stdout: 0 };
      let settled = false;
      let spawnError: Error | undefined;
      let terminalError: Error | undefined;
      let termination: Promise<void> | undefined;

      const terminate = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        child.stdout.pause();
        child.stderr.pause();
        termination = terminateOwnedTree(child);
      };
      const collect = (stream: 'stderr' | 'stdout', chunk: Buffer) => {
        if (terminalError) return;
        if (outputBytes[stream] + chunk.byteLength > maxOutputBytes) {
          terminate(new ProcessOutputLimitError(stream, maxOutputBytes));
          return;
        }
        outputBytes[stream] += chunk.byteLength;
        output[stream].push(chunk);
      };
      const abort = () => {
        if (options.signal) terminate(abortError(options.signal));
      };
      const settle = async (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        await termination;
        if (terminalError) {
          rejectResult(terminalError);
          return;
        }
        if (spawnError) {
          rejectResult(spawnError);
          return;
        }
        resolveResult({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(output.stdout, outputBytes.stdout).toString(
            'utf8',
          ),
          stderr: Buffer.concat(output.stderr, outputBytes.stderr).toString(
            'utf8',
          ),
        });
      };

      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.once('error', (error) => {
        spawnError = error;
        if (!child.pid) void settle(null);
      });
      child.once('close', (exitCode) => void settle(exitCode));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
